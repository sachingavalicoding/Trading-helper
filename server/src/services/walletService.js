import mongoose from 'mongoose';
import { Wallet, Order, Position, Trade } from '../models/index.js';
import { round2 } from '../utils/money.js';

export async function getOrCreateWallet(userId, startingBalance) {
  return Wallet.findOneAndUpdate(
    { user: userId },
    { $setOnInsert: { balance: startingBalance, startingBalance } },
    { upsert: true, new: true },
  );
}

/** Cash, margin in use and what is free to trade with. */
export async function getFunds(userId, startingBalance) {
  const uid = new mongoose.Types.ObjectId(String(userId));
  const [wallet, [pos], [ord]] = await Promise.all([
    getOrCreateWallet(uid, startingBalance),
    Position.aggregate([{ $match: { user: uid, status: 'OPEN' } }, { $group: { _id: null, margin: { $sum: '$margin' } } }]),
    Order.aggregate([{ $match: { user: uid, status: 'OPEN' } }, { $group: { _id: null, blocked: { $sum: '$blockedMargin' } } }]),
  ]);
  const usedMargin = round2(pos?.margin || 0);
  const blockedMargin = round2(ord?.blocked || 0);
  return {
    balance: round2(wallet.balance),
    startingBalance: wallet.startingBalance,
    usedMargin,
    blockedMargin,
    available: round2(wallet.balance - usedMargin - blockedMargin),
    realizedPnl: round2(wallet.balance - wallet.startingBalance),
    resetCount: wallet.resetCount,
    lastResetAt: wallet.lastResetAt,
  };
}

export async function adjustBalance(userId, delta) {
  await Wallet.updateOne({ user: userId }, { $inc: { balance: round2(delta) } });
}

/** Start over: wipe orders, positions and trades and restore the starting balance. */
export async function resetAccount(userId, startingBalance) {
  await Promise.all([
    Order.deleteMany({ user: userId }),
    Position.deleteMany({ user: userId }),
    Trade.deleteMany({ user: userId }),
  ]);
  await Wallet.updateOne(
    { user: userId },
    { $set: { balance: startingBalance, startingBalance, lastResetAt: new Date() }, $inc: { resetCount: 1 } },
    { upsert: true },
  );
}
