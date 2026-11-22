export const SLOTS = ['menuName', 'feature', 'price', 'storeName', 'limitedOffer', 'cta'];
export const TEMPLATES_VERSION = 1;
const copy = Object.fromEntries(['ko', 'en', 'zh-Hans', 'zh-Hant'].map(locale => [locale, {
  type: 'string', minLength: 1, maxLength: 28,
}]));
const script = {
  type: 'object', additionalProperties: false, required: ['id', 'lengthSec', 'tone', 'cta', 'slots'],
  properties: {
    id: { type: 'string', pattern: '^(warm|clean)-(10|15|30)$' },
    lengthSec: { type: 'integer', enum: [10, 15, 30] },
    tone: { type: 'string', enum: ['warm', 'clean'] },
    cta: { type: 'object', additionalProperties: false, required: Object.keys(copy), properties: copy },
    slots: { type: 'array', minItems: SLOTS.length, maxItems: SLOTS.length, items: { type: 'string', enum: SLOTS } },
  },
};
export const AUTHOR_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['html', 'variants'],
  properties: {
    html: { type: 'string', minLength: 150, maxLength: 18000 },
    variants: { type: 'array', minItems: 6, maxItems: 6, items: script },
  },
};

const orders = ['menu-first', 'visual-first', 'shop-first'];
const variantKeys = ['warm-10', 'clean-10', 'warm-15', 'clean-15', 'warm-30', 'clean-30'];
const authoredVariant = { type: 'object', additionalProperties: false, required: ['cta', 'order'], properties: {
  cta: script.properties.cta, order: { type: 'string', enum: orders },
} };
export const AUTHOR_REQUEST_SCHEMA = {
  ...AUTHOR_SCHEMA,
  properties: { ...AUTHOR_SCHEMA.properties, variants: { type: 'object', additionalProperties: false,
    required: variantKeys, properties: Object.fromEntries(variantKeys.map(key => [key, authoredVariant])) } },
};

export function buildAuthoredTemplate({ html, variants }) {
  const orderedSlots = {
    'menu-first': SLOTS,
    'visual-first': ['feature', 'menuName', 'limitedOffer', 'price', 'cta', 'storeName'],
    'shop-first': ['storeName', 'cta', 'menuName', 'feature', 'price', 'limitedOffer'],
  };
  return { html, variants: variantKeys.map(id => {
    const [tone, length] = id.split('-');
    return { id, tone, lengthSec: Number(length), cta: variants[id].cta, slots: orderedSlots[variants[id].order] };
  }) };
}

export function templateStructureValid(template) {
  const tokens = ['LOCALE', 'BASE_STYLE', 'SCENES', 'PLAYER'];
  return tokens.every(token => template.html.split(`{{${token}}}`).length === 2)
    && !/<script\b/i.test(template.html)
    && new Set(template.variants.map(variant => variant.id)).size === 6
    && template.variants.every(variant => variant.id === `${variant.tone}-${variant.lengthSec}`
      && new Set(variant.slots).size === SLOTS.length);
}
