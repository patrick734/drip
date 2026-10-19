const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const E = (n) => ethers.parseEther(String(n));
const DAY = 24 * 3600;
const NATIVE = ethers.ZeroAddress;
const withFee = (a) => a + (a * 25n) / 10000n;

async function deploy() {
  const [owner, treasury, alice, bob, carol] = await ethers.getSigners();
  const d = await (await ethers.getContractFactory("Drip")).deploy(owner.address, treasury.address);
  const tok = await (await ethers.getContractFactory("MockToken")).deploy("USD Test", "USDT", 18);
  const feeTok = await (await ethers.getContractFactory("FeeToken")).deploy();
  for (const a of [alice, bob]) {
    await tok.mint(a.address, E(1_000_000));
    await feeTok.mint(a.address, E(1000));
    await tok.connect(a).approve(d.target, ethers.MaxUint256);
    await feeTok.connect(a).approve(d.target, ethers.MaxUint256);
  }
  return { d, tok, feeTok, owner, treasury, alice, bob, carol };
}
const now = async () => BigInt(await time.latest());

// alice streams 1000 BOT to bob over 100 days starting next block
async function nativeStream() {
  const f = await deploy();
  const t = await now();
  await f.d.connect(f.alice).create(f.bob.address, NATIVE, E(1000), 0, t + BigInt(100 * DAY) + 1n, "Salary", { value: withFee(E(1000)) });
  return { ...f, id: 1n, s: await f.d.getStream(1) };
}
async function tokenStream() {
  const f = await deploy();
  const t = await now();
  await f.d.connect(f.alice).create(f.bob.address, f.tok.target, E(1000), t + BigInt(DAY), t + BigInt(11 * DAY), "Grant");
  return { ...f, id: 1n, s: await f.d.getStream(1) };
}

describe("Drip", () => {
  describe("create", () => {
    it("native: takes amount + 0.25% fee, indexes both sides", async () => {
      const { d, alice, bob, id, s } = await loadFixture(nativeStream);
      expect(await ethers.provider.getBalance(d.target)).to.equal(withFee(E(1000)));
      expect(await d.feesAccrued(NATIVE)).to.equal(E(2.5));
      expect(s.deposit).to.equal(E(1000));
      expect(s.memo).to.equal("Salary");
      expect(await d.streamsBySender(alice.address)).to.deep.equal([id]);
      expect(await d.streamsByRecipient(bob.address)).to.deep.equal([id]);
    });

    it("token: pulls amount + fee", async () => {
      const { d, tok, alice } = await loadFixture(tokenStream);
      expect(await tok.balanceOf(d.target)).to.equal(withFee(E(1000)));
      expect(await tok.balanceOf(alice.address)).to.equal(E(1_000_000) - withFee(E(1000)));
    });

    it("exact amount required", async () => {
      const { d, tok, alice, bob } = await loadFixture(deploy);
      const end = (await now()) + 1000n;
      await expect(d.connect(alice).create(bob.address, NATIVE, E(1), 0, end, "", { value: E(1) })).to.be.revertedWithCustomError(d, "WrongAmount");
      await expect(d.connect(alice).create(bob.address, tok.target, E(1), 0, end, "", { value: 1 })).to.be.revertedWithCustomError(d, "WrongAmount");
    });

    it("rejects bad params", async () => {
      const { d, alice, bob } = await loadFixture(deploy);
      const t = await now(); const v = { value: withFee(E(1)) };
      await expect(d.connect(alice).create(ethers.ZeroAddress, NATIVE, E(1), 0, t + 100n, "", v)).to.be.revertedWithCustomError(d, "InvalidParams");
      await expect(d.connect(alice).create(alice.address, NATIVE, E(1), 0, t + 100n, "", v)).to.be.revertedWithCustomError(d, "InvalidParams");
      await expect(d.connect(alice).create(bob.address, NATIVE, 0, 0, t + 100n, "", { value: 0 })).to.be.revertedWithCustomError(d, "InvalidParams");
      await expect(d.connect(alice).create(bob.address, NATIVE, E(1), t - 10n, t + 100n, "", v)).to.be.revertedWithCustomError(d, "InvalidParams");
      await expect(d.connect(alice).create(bob.address, NATIVE, E(1), t + 200n, t + 100n, "", v)).to.be.revertedWithCustomError(d, "InvalidParams");
      await expect(d.connect(alice).create(bob.address, NATIVE, E(1), 0, t + BigInt(5 * 365 * DAY) + 10n, "", v)).to.be.revertedWithCustomError(d, "InvalidParams");
      await expect(d.connect(alice).create(bob.address, NATIVE, E(1), t + BigInt(366 * DAY), t + BigInt(400 * DAY), "", v)).to.be.revertedWithCustomError(d, "InvalidParams");
      await expect(d.connect(alice).create(bob.address, NATIVE, E(1), 0, t + 100n, "x".repeat(141), v)).to.be.revertedWithCustomError(d, "InvalidParams");
    });

    it("rejects fee-on-transfer tokens", async () => {
      const { d, feeTok, alice, bob } = await loadFixture(deploy);
      await expect(d.connect(alice).create(bob.address, feeTok.target, E(10), 0, (await now()) + 1000n, "")).to.be.revertedWithCustomError(d, "InvalidParams");
    });
  });

  describe("flow", () => {
    it("recipient withdraws as it flows, full amount at end", async () => {
      const { d, alice, bob, id, s } = await loadFixture(nativeStream);
      await time.increaseTo(s.start + BigInt(25 * DAY));
      expect(await d.withdrawable(id)).to.be.closeTo(E(250), E(0.001));
      await expect(d.connect(bob).withdraw(id)).to.changeEtherBalance(bob, (x) => x > E(249.99) && x < E(250.02));
      await time.increaseTo(s.end);
      await d.connect(bob).withdraw(id);
      expect((await d.getStream(id)).withdrawn).to.equal(E(1000));
      await expect(d.connect(bob).withdraw(id)).to.be.revertedWithCustomError(d, "NothingToWithdraw");
      await expect(d.connect(alice).withdraw(id)).to.be.revertedWithCustomError(d, "NotAuthorized");
    });

    it("nothing flows before a future start", async () => {
      const { d, bob, id, s } = await loadFixture(tokenStream);
      expect(await d.withdrawable(id)).to.equal(0);
      await expect(d.connect(bob).withdraw(id)).to.be.revertedWithCustomError(d, "NothingToWithdraw");
      await time.increaseTo(s.start + BigInt(5 * DAY));
      expect(await d.withdrawable(id)).to.equal(E(500));
    });
  });

  describe("cancel", () => {
    it("sender cancels midway: recipient keeps what flowed, sender refunded rest", async () => {
      const { d, alice, bob, id, s } = await loadFixture(nativeStream);
      await time.increaseTo(s.start + BigInt(40 * DAY) - 1n);
      const tx = d.connect(alice).cancel(id);
      await expect(tx).to.changeEtherBalance(alice, E(600));
      const after = await d.getStream(id);
      expect(after.cancelled).to.equal(true);
      expect(after.deposit).to.equal(E(400));
      await time.increase(30 * DAY); // nothing more flows after cancel
      expect(await d.withdrawable(id)).to.equal(E(400));
      await expect(d.connect(bob).withdraw(id)).to.changeEtherBalance(bob, E(400));
      expect(await ethers.provider.getBalance(d.target)).to.equal(E(2.5)); // only the fee remains
    });

    it("recipient can cancel too; cancel before start refunds everything", async () => {
      const { d, tok, alice, bob, id } = await loadFixture(tokenStream);
      await expect(d.connect(bob).cancel(id)).to.changeTokenBalance(tok, alice, E(1000));
      expect(await d.withdrawable(id)).to.equal(0);
      await time.increase(20 * DAY);
      expect(await d.withdrawable(id)).to.equal(0);
    });

    it("only parties, only once, not after it finished", async () => {
      const { d, alice, carol, id, s } = await loadFixture(nativeStream);
      await expect(d.connect(carol).cancel(id)).to.be.revertedWithCustomError(d, "NotAuthorized");
      await d.connect(alice).cancel(id);
      await expect(d.connect(alice).cancel(id)).to.be.revertedWithCustomError(d, "StreamFinished");
      const f2 = await loadFixture(nativeStream);
      await time.increaseTo(f2.s.end);
      await expect(f2.d.connect(f2.alice).cancel(f2.id)).to.be.revertedWithCustomError(f2.d, "StreamFinished");
    });
  });

  describe("fees & admin", () => {
    it("fees go to treasury per token, callable by anyone", async () => {
      const { d, tok, treasury, alice, bob, carol } = await loadFixture(nativeStream);
      await d.connect(alice).create(bob.address, tok.target, E(400), 0, (await now()) + 1000n, "");
      await expect(d.connect(carol).collectFees(NATIVE)).to.changeEtherBalance(treasury, E(2.5));
      await expect(d.connect(carol).collectFees(tok.target)).to.changeTokenBalance(tok, treasury, E(1));
      await expect(d.collectFees(NATIVE)).to.be.revertedWithCustomError(d, "NothingToWithdraw");
    });

    it("fee capped at 1%, owner only", async () => {
      const { d, owner, alice, treasury } = await loadFixture(deploy);
      await expect(d.connect(alice).setConfig(10, treasury.address)).to.be.revertedWithCustomError(d, "OwnableUnauthorizedAccount");
      await expect(d.connect(owner).setConfig(101, treasury.address)).to.be.revertedWithCustomError(d, "InvalidParams");
      await d.connect(owner).setConfig(100, alice.address);
      expect(await d.feeFor(E(100))).to.equal(E(1));
    });

    it("pause blocks new streams only", async () => {
      const { d, owner, alice, bob, id, s } = await loadFixture(nativeStream);
      await d.connect(owner).pause();
      await expect(d.connect(alice).create(bob.address, NATIVE, E(1), 0, (await now()) + 100n, "", { value: withFee(E(1)) })).to.be.revertedWithCustomError(d, "EnforcedPause");
      await time.increaseTo(s.start + BigInt(50 * DAY));
      await d.connect(bob).withdraw(id);
      await d.connect(alice).cancel(id);
    });

    it("owner has no way to move streamed funds", async () => {
      const { d } = await loadFixture(deploy);
      const fns = d.interface.fragments.filter(f => f.type === "function" && !["view", "pure"].includes(f.stateMutability)).map(f => f.name).sort();
      expect(fns).to.deep.equal(["acceptOwnership", "cancel", "collectFees", "create", "pause", "renounceOwnership", "setConfig", "transferOwnership", "unpause", "withdraw"]);
    });
  });

  describe("solvency", () => {
    it("balance == fees + every stream's deposit minus withdrawn", async () => {
      const { d, tok, alice, bob, carol } = await loadFixture(deploy);
      const t = await now();
      await d.connect(alice).create(bob.address, NATIVE, E(300), 0, t + BigInt(30 * DAY), "a", { value: withFee(E(300)) });
      await d.connect(bob).create(carol.address, NATIVE, E(77), t + BigInt(DAY), t + BigInt(9 * DAY), "b", { value: withFee(E(77)) });
      await d.connect(alice).create(carol.address, NATIVE, E(5), 0, t + BigInt(400 * DAY), "c", { value: withFee(E(5)) });
      await d.connect(alice).create(carol.address, tok.target, E(1234), 0, t + BigInt(10 * DAY), "d");
      await time.increase(5 * DAY);
      await d.connect(bob).withdraw(1);
      await d.connect(carol).withdraw(2);
      await d.connect(alice).cancel(3);
      await time.increase(4 * DAY);
      await d.connect(carol).cancel(4);
      await d.connect(carol).withdraw(4);
      let owedNative = await d.feesAccrued(NATIVE), owedTok = await d.feesAccrued(tok.target);
      for (const id of [1, 2, 3, 4]) {
        const s = await d.getStream(id);
        const left = s.deposit - s.withdrawn;
        if (s.token === NATIVE) owedNative += left; else owedTok += left;
      }
      expect(await ethers.provider.getBalance(d.target)).to.equal(owedNative);
      expect(await tok.balanceOf(d.target)).to.equal(owedTok);
    });
  });
});
