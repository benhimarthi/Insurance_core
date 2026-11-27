import { useEffect, useState } from 'react';
import { formText, describeCondition, valueLabel } from './rulesFormText.js';

/** Path as the server validator writes it: ['risk', 'factors', 0, 'points'] -> "risk.factors[0].points". */
const pathOf = (parts) => parts.reduce((s, k) => (typeof k === 'number' ? `${s}[${k}]` : s ? `${s}.${k}` : k), '');

/** Immutable update: a copy of `obj` with `value` at `parts` (undefined removes the key). */
function setIn(obj, parts, value) {
  const copy = structuredClone(obj);
  let cur = copy;
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (cur[parts[i]] === undefined || cur[parts[i]] === null) cur[parts[i]] = typeof parts[i + 1] === 'number' ? [] : {};
    cur = cur[parts[i]];
  }
  const last = parts[parts.length - 1];
  if (value === undefined) delete cur[last]; else cur[last] = value;
  return copy;
}
const getIn = (obj, parts) => parts.reduce((o, k) => (o == null ? undefined : o[k]), obj);

/** Number input that accepts "1,5" and half-typed values ("0.") without fighting the user. */
function NumberInput({ value, onChange, readOnly, id, invalid }) {
  const show = (v) => (v === null || v === undefined ? '' : String(v));
  const [text, setText] = useState(show(value));
  const parse = (raw) => {
    const t = raw.trim().replace(',', '.');
    if (t === '') return null;
    return /^-?\d*\.?\d*$/.test(t) && t !== '-' && t !== '.' ? Number(t) : undefined;
  };
  useEffect(() => { if (parse(text) !== value) setText(show(value)); }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <input
      id={id} inputMode="decimal" value={text} readOnly={readOnly} aria-invalid={invalid || undefined}
      onChange={(e) => { setText(e.target.value); const n = parse(e.target.value); if (n !== undefined) onChange(n); }}
      onBlur={() => setText(show(value))}
    />
  );
}

/**
 * Form view of the rules: the values people change day to day. Rules and their conditions are
 * shown in plain language; adding a rule or changing a condition is done in the JSON view.
 * Every change produces a new config object (the editor keeps one draft for both views).
 */
export function RulesForm({ config, onChange, readOnly, errors = [], lang }) {
  const x = formText(lang);
  const errorAt = (parts) => errors.filter((e) => e.path === pathOf(parts)).map((e) => e.message).join(' · ');
  const set = (parts, value) => onChange(setIn(config, parts, value));
  const setOptional = (parts, value) => set(parts, value === null ? undefined : value);

  let n = 0;
  // render helpers are plain functions, not components: inputs keep their identity (and focus) across renders
  const field = ({ label, parts, kind = 'number', optional = false, hint, key }) => {
    const id = `rf-${(n += 1)}`;
    const err = errorAt(parts);
    const value = getIn(config, parts);
    let input;
    if (kind === 'number') input = <NumberInput id={id} value={value} readOnly={readOnly} invalid={!!err} onChange={(v) => (optional ? setOptional(parts, v) : set(parts, v))} />;
    else if (kind === 'bool') input = <input id={id} type="checkbox" checked={!!value} disabled={readOnly} onChange={(e) => set(parts, e.target.checked)} />;
    else input = <input id={id} value={value ?? ''} readOnly={readOnly} aria-invalid={!!err || undefined} onChange={(e) => set(parts, kind === 'upper' ? e.target.value.toUpperCase() : e.target.value)} />;
    return (
      <div key={key || pathOf(parts)} className={`rf-field ${kind === 'bool' ? 'rf-bool' : ''}`}>
        <label htmlFor={id}>{label}</label>
        {input}
        {hint && <small className="muted">{hint}</small>}
        {err && <small className="rf-error">{err}</small>}
      </div>
    );
  };

  // a section opens by itself when the last check found problems in it, and says how many
  const errorsUnder = (prefixes) => errors.filter((e) => prefixes.some((p) => e.path === p || e.path.startsWith(`${p}.`) || e.path.startsWith(`${p}[`))).length;
  const section = ({ title, children, open = false, prefixes = [] }) => {
    const count = errorsUnder(prefixes);
    return (
      <details className="rf-section" open={open || count > 0}>
        <summary>{title}{count > 0 && <span className="badge err">{count}</span>}</summary>
        <div className="rf-body">{children}</div>
      </details>
    );
  };

  const rule = ({ parts, rule: r, children, key }) => (
    <div className="rf-rule" key={key}>
      <div className="rf-cond"><span className="muted">{x.f.condition} :</span> {describeCondition(r.when, lang)} <code className="muted">{r.id}</code></div>
      <div className="rf-grid">{children}</div>
      {errorAt([...parts, 'when']) && <small className="rf-error">{errorAt([...parts, 'when'])}</small>}
    </div>
  );

  const coverages = Object.keys((config.pricing && config.pricing.base) || {});
  const bands = ((config.risk && config.risk.bands) || []).map((b) => b && b.band);
  const zones = Object.entries(config.zoneMap || {}).filter(([k]) => k !== 'default');
  const zoneOptions = [...new Set(['low', 'medium', 'high', ...Object.values(config.zoneMap || {})])];
  const setZones = (entries) => {
    const next = Object.fromEntries(entries);
    if (config.zoneMap && 'default' in config.zoneMap) next.default = config.zoneMap.default;
    set(['zoneMap'], next);
  };
  const docs = (config.documents && config.documents.required) || [];

  return (
    <div className="rules-form">
      <p className="muted">{x.conditionsHint}</p>

      {section({ title: x.sections.general, open: true, prefixes: ['version', 'currency', 'branding', 'line', 'requiredFields'], children: (<>
        <div className="rf-grid">
          {field({ label: x.f.version, parts: ['version'], kind: "text" })}
          {field({ label: x.f.currency, parts: ['currency'], kind: "upper" })}
          {field({ label: x.f.insurerName, parts: ['branding', 'insurerName'], kind: "text" })}
          <div className="rf-field">
            <label htmlFor="rf-color">{x.f.primaryColor}</label>
            <span className="rf-color">
              <input id="rf-color" type="color" value={(config.branding && config.branding.primaryColor) || '#1f4e79'} disabled={readOnly} onChange={(e) => set(['branding', 'primaryColor'], e.target.value.toUpperCase())} />
              <code>{config.branding && config.branding.primaryColor}</code>
            </span>
          </div>
        </div>
      </>) })}

      {section({ title: x.sections.pricing, open: true, prefixes: ['pricing.base', 'pricing.valueRate', 'pricing.policyFee', 'pricing.bandLoading'], children: (<>
        <div className="rf-grid">
          {coverages.map((c) => field({ key: `b-${c}`, label: `${x.f.base} · ${valueLabel(lang, c)}`, parts: ['pricing', 'base', c] }))}
          {coverages.map((c) => field({ key: `v-${c}`, label: `${x.f.valueRate} · ${valueLabel(lang, c)}`, parts: ['pricing', 'valueRate', c], optional: true }))}
          {field({ label: x.f.policyFee, parts: ['pricing', 'policyFee'], optional: true })}
          {bands.map((b) => field({ key: `l-${b}`, label: `${x.f.bandLoading} · ${valueLabel(lang, b)}`, parts: ['pricing', 'bandLoading', b], optional: true }))}
        </div>
      </>) })}

      {section({ title: x.sections.multipliers, prefixes: ['pricing.multipliers'], children: (<>
        {((config.pricing && config.pricing.multipliers) || []).map((m, i) => (
          rule({ key: m.id || i, parts: ['pricing', 'multipliers', i], rule: m, children: (<>
            {field({ label: x.f.label, parts: ['pricing', 'multipliers', i, 'label'], kind: "text" })}
            {field({ label: x.f.factor, parts: ['pricing', 'multipliers', i, 'factor'] })}
          </>) })
        ))}
      </>) })}

      {section({ title: x.sections.risk, prefixes: ['risk'], children: (<>
        <div className="rf-grid">
          {field({ label: x.f.referAt, parts: ['risk', 'referAt'] })}
          {field({ label: x.f.refuseAt, parts: ['risk', 'refuseAt'] })}
        </div>
        <h4>{x.f.bands}</h4>
        <div className="rf-grid">
          {bands.map((b, i) => field({ key: `band-${b}-${i}`, label: valueLabel(lang, b), parts: ['risk', 'bands', i, 'maxScore'] }))}
        </div>
        {((config.risk && config.risk.factors) || []).map((f, i) => (
          rule({ key: f.id || i, parts: ['risk', 'factors', i], rule: f, children: (<>
            {field({ label: x.f.label, parts: ['risk', 'factors', i, 'label'], kind: "text" })}
            {field({ label: x.f.points, parts: ['risk', 'factors', i, 'points'] })}
          </>) })
        ))}
      </>) })}

      {section({ title: x.sections.eligibility, prefixes: ['eligibility'], children: (<>
        {(config.eligibility || []).map((r, i) => (
          rule({ key: r.id || i, parts: ['eligibility', i], rule: r, children: (<>
            <div className="rf-field">
              <label htmlFor={`rf-out-${i}`}>{x.f.outcome}</label>
              <select id={`rf-out-${i}`} value={r.outcome} disabled={readOnly} onChange={(e) => set(['eligibility', i, 'outcome'], e.target.value)}>
                {['refer', 'refuse'].map((o) => <option key={o} value={o}>{x.outcomes[o]}</option>)}
              </select>
            </div>
            {field({ label: x.f.message, parts: ['eligibility', i, 'message'], kind: "text" })}
          </>) })
        ))}
      </>) })}

      {section({ title: x.sections.zones, prefixes: ['zoneMap'], children: (<>
        <div className="rf-zones">
          {zones.map(([city, zone], i) => (
            <div className="rf-zone" key={i}>
              <input aria-label={x.f.city} value={city} readOnly={readOnly}
                onChange={(e) => setZones(zones.map((z, j) => (j === i ? [e.target.value.toLowerCase(), z[1]] : z)))} />
              <select aria-label={x.f.zone} value={zone} disabled={readOnly} onChange={(e) => setZones(zones.map((z, j) => (j === i ? [z[0], e.target.value] : z)))}>
                {zoneOptions.map((o) => <option key={o} value={o}>{valueLabel(lang, o)}</option>)}
              </select>
              {!readOnly && <button type="button" onClick={() => setZones(zones.filter((_, j) => j !== i))}>{x.f.remove}</button>}
            </div>
          ))}
          <div className="rf-zone">
            <span className="muted">{x.f.defaultZone}</span>
            <select aria-label={x.f.defaultZone} value={(config.zoneMap && config.zoneMap.default) || 'low'} disabled={readOnly} onChange={(e) => set(['zoneMap', 'default'], e.target.value)}>
              {zoneOptions.map((o) => <option key={o} value={o}>{valueLabel(lang, o)}</option>)}
            </select>
          </div>
          {!readOnly && (
            <button type="button" onClick={() => { let k = 'ville'; let i = 2; while (zones.some(([c]) => c === k)) { k = `ville-${i}`; i += 1; } setZones([...zones, [k, 'low']]); }}>
              {x.f.addCity}
            </button>
          )}
        </div>
      </>) })}

      {section({ title: x.sections.documents, prefixes: ['documents'], children: (<>
        <div className="rf-field">
          <span>{x.f.required}</span>
          {['national_id', 'vehicle_registration'].map((d) => (
            <label key={d} className="check">
              <input type="checkbox" checked={docs.includes(d)} disabled={readOnly}
                onChange={(e) => set(['documents', 'required'], e.target.checked ? [...docs, d] : docs.filter((y) => y !== d))} />
              {x.docTypes[d]}
            </label>
          ))}
        </div>
        <div className="rf-grid">
          {field({ label: x.f.resubmitBelow, parts: ['documents', 'resubmitBelow'], optional: true })}
          {field({ label: x.f.maxResubmits, parts: ['documents', 'maxResubmits'], optional: true })}
          {field({ label: x.f.ageTolerance, parts: ['documents', 'ageTolerance'], optional: true })}
          {field({ label: x.f.vehicleAgeTolerance, parts: ['documents', 'vehicleAgeTolerance'], optional: true })}
          {field({ label: x.f.nameSimilarityMin, parts: ['documents', 'nameSimilarityMin'], optional: true })}
        </div>
      </>) })}

      {section({ title: x.sections.policy, prefixes: ['policy', 'payment'], children: (<>
        <div className="rf-grid">
          {field({ label: x.f.numberPrefix, parts: ['policy', 'numberPrefix'], kind: "upper" })}
          {field({ label: x.f.durationMonths, parts: ['policy', 'durationMonths'], optional: true })}
          {field({ label: x.f.startOffsetDays, parts: ['policy', 'startOffsetDays'], optional: true })}
          {field({ label: x.f.linkExpiryMinutes, parts: ['payment', 'linkExpiryMinutes'], optional: true })}
        </div>
      </>) })}

      {section({ title: x.sections.limits, prefixes: ['authorization', 'escalation', 'coverageInfo'], children: (<>
        <div className="rf-grid">
          {field({ label: x.f.underwriterPremiumLimit, parts: ['authorization', 'underwriterPremiumLimit'], optional: true })}
          {field({ label: x.f.maxAutoVehicleValue, parts: ['escalation', 'maxAutoVehicleValue'] })}
          {field({ label: x.f.minConfidence, parts: ['escalation', 'minConfidence'] })}
          {field({ label: x.f.autoDecline, parts: ['escalation', 'autoDecline'], kind: "bool" })}
        </div>
      </>) })}
    </div>
  );
}
