// 구조화 출력 확인용 작은 JSON Schema 부분 검사기(쓰는 키워드만: type·properties·required·
// additionalProperties·items·enum·minLength·maxLength·minItems·maxItems·minimum·maximum·pattern).
const typeOk = (type, v) => {
  switch (type) {
    case 'object': return v !== null && typeof v === 'object' && !Array.isArray(v);
    case 'array': return Array.isArray(v);
    case 'string': return typeof v === 'string';
    case 'integer': return Number.isInteger(v);
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'boolean': return typeof v === 'boolean';
    case 'null': return v === null;
    default: return true;
  }
};

export function validateSchema(schema, value, path = '$', errors = []) {
  if (!schema || errors.length > 20) return errors;
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : null;
  if (types && !types.some(t => typeOk(t, value))) { errors.push(`${path}: type`); return errors; }
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: enum`);
  if (typeof value === 'string') {
    const len = [...value].length;
    if (schema.minLength !== undefined && len < schema.minLength) errors.push(`${path}: minLength`);
    if (schema.maxLength !== undefined && len > schema.maxLength) errors.push(`${path}: maxLength`);
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) errors.push(`${path}: pattern`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: minimum`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: maximum`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: minItems`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: maxItems`);
    if (schema.items) value.forEach((item, i) => validateSchema(schema.items, item, `${path}[${i}]`, errors));
  }
  if (typeOk('object', value)) {
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) errors.push(`${path}.${key}: required`);
    const props = schema.properties || {};
    for (const [key, v] of Object.entries(value)) {
      if (Object.hasOwn(props, key)) validateSchema(props[key], v, `${path}.${key}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${path}.${key}: additional`);
    }
  }
  return errors;
}
