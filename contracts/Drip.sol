// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @title Drip
/// @notice Per-second payment streams on BOT Chain, in native BOT or any ERC-20.
///         A sender deposits an amount that flows to a recipient evenly between a
///         start and end time. The recipient withdraws what has flowed whenever they
///         like. Either side can cancel: the recipient keeps what has already flowed
///         and the sender gets the rest back immediately.
/// @dev    token == address(0) means native BOT. The platform fee is charged on top
///         of the streamed amount at creation, so recipients always receive exactly
///         what the sender chose. Fee-on-transfer and rebasing tokens are rejected
///         or unsupported respectively.
contract Drip is Ownable2Step, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    struct Stream {
        address sender;
        uint40 start;
        uint40 end;
        bool cancelled;
        address recipient;
        address token;
        uint128 deposit;   // total the recipient can ever receive (reduced on cancel)
        uint128 withdrawn;
        string memo;
    }

    uint16 public constant MAX_FEE_BPS = 100; // 1% hard cap
    uint40 public constant MAX_DURATION = 5 * 365 days;
    uint40 public constant MAX_START_DELAY = 365 days;

    uint16 public feeBps = 25; // 0.25%
    address public treasury;
    mapping(address => uint256) public feesAccrued; // token => amount

    uint256 public streamCount;
    mapping(uint256 => Stream) private _streams;
    mapping(address => uint256[]) private _bySender;
    mapping(address => uint256[]) private _byRecipient;

    event StreamCreated(uint256 indexed id, address indexed sender, address indexed recipient, address token, uint256 amount, uint256 fee, uint256 start, uint256 end, string memo);
    event Withdrawn(uint256 indexed id, address indexed recipient, uint256 amount);
    event Cancelled(uint256 indexed id, address indexed by, uint256 toRecipient, uint256 refunded);
    event FeesCollected(address indexed token, address indexed treasury, uint256 amount);
    event ConfigUpdated(uint16 feeBps, address treasury);

    error InvalidParams();
    error WrongAmount();
    error NotAuthorized();
    error NothingToWithdraw();
    error StreamFinished();
    error TransferFailed();

    constructor(address owner_, address treasury_) Ownable(owner_) {
        if (treasury_ == address(0)) revert InvalidParams();
        treasury = treasury_;
    }

    /// @notice Fee owed on top of `amount` at the current rate.
    function feeFor(uint256 amount) public view returns (uint256) {
        return (amount * feeBps) / 10_000;
    }

    // ------------------------------------------------------------ streams

    /// @notice Start a stream. `start` = 0 means now. For native BOT send exactly
    ///         amount + feeFor(amount); for tokens, approve that total first.
    function create(address recipient, address token, uint128 amount, uint40 start, uint40 end, string calldata memo)
        external
        payable
        nonReentrant
        whenNotPaused
        returns (uint256 id)
    {
        if (start == 0) start = uint40(block.timestamp);
        if (
            recipient == address(0) || recipient == msg.sender || amount == 0 || bytes(memo).length > 140
                || start < block.timestamp || start > block.timestamp + MAX_START_DELAY || end <= start
                || end - start > MAX_DURATION
        ) revert InvalidParams();

        uint256 fee = feeFor(amount);
        uint256 total = uint256(amount) + fee;
        if (token == address(0)) {
            if (msg.value != total) revert WrongAmount();
        } else {
            if (msg.value != 0) revert WrongAmount();
            uint256 before = IERC20(token).balanceOf(address(this));
            IERC20(token).safeTransferFrom(msg.sender, address(this), total);
            if (IERC20(token).balanceOf(address(this)) - before != total) revert InvalidParams(); // no fee-on-transfer
        }

        id = ++streamCount;
        Stream storage s = _streams[id];
        s.sender = msg.sender;
        s.recipient = recipient;
        s.token = token;
        s.start = start;
        s.end = end;
        s.deposit = amount;
        s.memo = memo;
        _bySender[msg.sender].push(id);
        _byRecipient[recipient].push(id);
        feesAccrued[token] += fee;

        emit StreamCreated(id, msg.sender, recipient, token, amount, fee, start, end, memo);
    }

    /// @notice Recipient withdraws everything that has flowed so far.
    function withdraw(uint256 id) external nonReentrant {
        Stream storage s = _streams[id];
        if (msg.sender != s.recipient) revert NotAuthorized();
        uint256 amount = _streamed(s) - s.withdrawn;
        if (amount == 0) revert NothingToWithdraw();
        s.withdrawn += uint128(amount);
        _pay(s.token, s.recipient, amount);
        emit Withdrawn(id, s.recipient, amount);
    }

    /// @notice Sender or recipient stops the stream. The recipient keeps (and can
    ///         still withdraw) what has flowed; the rest goes back to the sender now.
    function cancel(uint256 id) external nonReentrant {
        Stream storage s = _streams[id];
        if (msg.sender != s.sender && msg.sender != s.recipient) revert NotAuthorized();
        if (s.cancelled || block.timestamp >= s.end) revert StreamFinished();
        uint256 owed = _streamed(s);
        uint256 refund = uint256(s.deposit) - owed;
        s.cancelled = true;
        s.deposit = uint128(owed);
        if (block.timestamp > s.start) s.end = uint40(block.timestamp);
        if (refund > 0) _pay(s.token, s.sender, refund);
        emit Cancelled(id, msg.sender, owed, refund);
    }

    // ------------------------------------------------------------ fees & admin

    /// @notice Sends accrued fees in `token` to the treasury. Anyone may call it.
    function collectFees(address token) external nonReentrant {
        uint256 amount = feesAccrued[token];
        if (amount == 0) revert NothingToWithdraw();
        feesAccrued[token] = 0;
        _pay(token, treasury, amount);
        emit FeesCollected(token, treasury, amount);
    }

    function setConfig(uint16 feeBps_, address treasury_) external onlyOwner {
        if (feeBps_ > MAX_FEE_BPS || treasury_ == address(0)) revert InvalidParams();
        feeBps = feeBps_;
        treasury = treasury_;
        emit ConfigUpdated(feeBps_, treasury_);
    }

    /// @notice Pausing only blocks new streams. Withdraw and cancel always work.
    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    // ------------------------------------------------------------ views

    function getStream(uint256 id) external view returns (Stream memory) { return _streams[id]; }

    /// @notice Total that has flowed to the recipient so far (withdrawn or not).
    function streamed(uint256 id) external view returns (uint256) { return _streamed(_streams[id]); }

    function withdrawable(uint256 id) external view returns (uint256) {
        Stream storage s = _streams[id];
        return _streamed(s) - s.withdrawn;
    }

    function streamsBySender(address a) external view returns (uint256[] memory) { return _bySender[a]; }
    function streamsByRecipient(address a) external view returns (uint256[] memory) { return _byRecipient[a]; }

    // ------------------------------------------------------------ internals

    function _streamed(Stream storage s) private view returns (uint256) {
        if (block.timestamp >= s.end) return s.deposit;
        if (block.timestamp <= s.start) return 0;
        return (uint256(s.deposit) * (block.timestamp - s.start)) / (uint256(s.end) - s.start);
    }

    function _pay(address token, address to, uint256 amount) private {
        if (token == address(0)) {
            (bool ok, ) = payable(to).call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }
}
