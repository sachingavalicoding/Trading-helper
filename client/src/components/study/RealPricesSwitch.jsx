import { Switch } from '../options/OptionsAutoCard.jsx';

/**
 * The switch that prices an options study from the real option candles saved each evening instead of the model.
 * It covers only the days saved so far (a day is added each evening and the oldest beyond 30 is dropped), and a trade whose contract was not saved is skipped.
 */
export function RealPricesSwitch({ on, setOn }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <p className="text-[11px] leading-snug text-muted">
        <b className="text-fg">Use the real option prices.</b> Prices each trade from the option's own saved candles instead of an estimate. It covers only the days saved so far (one more each evening, up to 30), so the days you pick below are cut down to those. A trade whose contract was not saved is skipped.
      </p>
      <Switch on={on} label="Use the real saved option prices" onClick={() => setOn((v) => !v)} />
    </div>
  );
}
