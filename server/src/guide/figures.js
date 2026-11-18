// The screenshots in the picture guide: which section each sits under, the file, and its caption.
// Every picture was taken from the real app on made-up demo data (see scripts/demo-server.js and scripts/guide-shots.mjs).
export const FIGURES = {
  1: [
    { file: 'm-stocks', caption: 'Stocks: the Nifty 50, search, filters, and the two auto traders at the top with what they made today.' },
    { file: 'm-more', caption: 'More: your money, then Settings, Research, this guide and the replay. P&L, Orders and Day review are small tabs under Trades.' },
    { file: 'm-settings', caption: 'More > Settings: every rule of one bot in one list, Options or Shares at the top. Tap a row to open it.' },
  ],
  5: [
    { file: 'm-study-form', caption: 'Research > Options study: pick days, how many trades a day, real option prices and "trade like the live bot".' },
    { file: 'm-study-results', caption: 'The result for each way of reading the chart: money made, win rate, average win and loss.' },
    { file: 'm-score-floors', caption: 'Open a row to see calls against puts, the worst losing run, and what a minimum chart score would have done.' },
    { file: 'd-study-results', caption: 'The same screen on a computer.', wide: true },
  ],
  6: [
    { file: 'm-combos', caption: 'Combos: the switch for buying on combinations, then each combination with its own switch, Checks, delete and Results and order settings.' },
    { file: 'm-combo-new', caption: 'A new combination: give it a name, then search and tap the checks.' },
  ],
  7: [
    { file: 'm-study-trades', caption: 'Every trade in a study has a View button.' },
    { file: 'm-view-popup', caption: 'View: why the entry happened, what happened next, and the numbers of the trade.' },
    { file: 'd-view-popup', caption: 'The View popup on a computer.', wide: true },
  ],
  9: [
    { file: 'm-pnl-top', caption: 'P&L: the running total and the profit or loss for each day, week or month.' },
    { file: 'm-pnl-charts', caption: 'Tap a bar for its numbers. Tables below: day by day, by weekday, by hour of entry and by symbol.' },
    { file: 'd-pnl-charts', caption: 'The P&L page on a computer.', wide: true },
  ],
};
