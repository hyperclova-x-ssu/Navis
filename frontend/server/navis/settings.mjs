import { AGENT_SETTINGS_COMMANDS, validateAgentToolArgs } from '../../shared/navis-agent-schema.mjs';

const unavailable = () => ({ outcome: 'refused', reason: 'unavailable' });
const current = (readings, section, key) => {
  const values = readings
    .filter(reading => !reading.args.section || reading.args.section === section)
    .flatMap(reading => (reading.facts ?? []).filter(fact => fact.key === key).map(fact => fact.value));
  return values.every(value => value === values[0]) ? values[0] : undefined;
};

const displayFields = {
  'settings.set_theme': ['theme', 'ui.theme'],
  'settings.set_text_scale': ['scale', 'ui.textScale'],
  'settings.set_locale': ['locale', 'ui.locale'],
  'settings.set_detail_fullscreen': ['fullscreen', 'ui.detailFullscreen'],
};

function prepareSettings(command, { input }) {
  const args = input.intent.args ?? {};
  if (!validateAgentToolArgs('propose_action', { command, args })) return unavailable();

  const readings = (input.readings ?? []).filter(reading => reading.tool === 'get_ui_state');
  if (current(readings, 'pos', 'ui.pos.approvalPending') !== 0
    || current(readings, 'display', 'ui.busy') === 1) return unavailable();

  const ready = () => ({ outcome: 'ready', args });
  const displayField = displayFields[command];
  if (displayField) {
    const [field, key] = displayField;
    const before = current(readings, 'display', key);
    const after = field === 'fullscreen' ? Number(args[field]) : args[field];
    return before === undefined || before === after ? unavailable() : ready();
  }

  const preview = key => current(readings, 'preview', `ui.preview.${key}`);
  const family = preview('family');
  if (!family) return unavailable();

  if (command === 'settings.set_closing_preview') {
    const closing = preview('closing');
    return closing === undefined || closing === (args.scenario ?? 'inherit') ? unavailable() : ready();
  }

  if (command === 'settings.set_preview_family' || command === 'settings.set_pos_preview') {
    const pos = preview('pos');
    const overrides = preview('overrideCount');
    if (pos === undefined || overrides === undefined) return unavailable();
    if (command === 'settings.set_preview_family') {
      return family === args.family && overrides === 0 && pos === 'inherit' ? unavailable() : ready();
    }
    const sameFamily = args.scenario !== 'payment-failure' || family === 'normal' && overrides === 0;
    return sameFamily && pos === (args.scenario ?? 'inherit') ? unavailable() : ready();
  }

  const { featureId } = args;
  const variants = readings.filter(reading => !reading.args.section || reading.args.section === 'preview')
    .flatMap(reading => (reading.facts ?? []).filter(fact => fact.key === `ui.preview.variant.${featureId}`).map(fact => fact.value));
  if (!variants.length) return { outcome: 'refused', reason: 'invalid_target' };
  const previous = preview(`override.${featureId}`) ?? 'inherit';
  const next = command === 'settings.reset_widget_preview' ? (family === 'normal' ? 'inherit' : 'normal') : args.variant ?? 'inherit';
  if (!['inherit', 'normal'].includes(next) && !variants.includes(next)) return { outcome: 'clarify', field: 'variant' };
  return previous === next ? unavailable() : ready();
}

// App presentation settings are proposals. Only the browser's action boundary
// can execute a confirmed card, with current store, snapshot and proposal checks.
export const settingsAdapters = AGENT_SETTINGS_COMMANDS.map(command => Object.freeze({
  command,
  prepare: context => prepareSettings(command, context),
}));
