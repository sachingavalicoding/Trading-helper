import { describe, expect, it } from 'vitest';
import { scoreVerdict } from './scoreStudy.js';

const band = (b, trades, avgNet) => ({ band: b, trades, avgNet, winRate: 50 });
describe('score study verdict', () => {
  it('needs two bands with enough ideas', () => {
    expect(scoreVerdict({ bands: { now: [band('70-79', 3, 100)] } })).toMatch(/Too few/);
  });
  it('says yes when the average rises with the score', () => {
    expect(scoreVerdict({ bands: { now: [band('60-69', 10, -200), band('70-79', 10, 0), band('80-89', 8, 300)] } })).toMatch(/^Yes/);
  });
  it('says no when high scores did no better', () => {
    expect(scoreVerdict({ bands: { now: [band('60-69', 10, 100), band('80-89', 8, -150)] } })).toMatch(/^No/);
  });
});
