import { expect, it } from 'vitest';
import { category, parseCreate, parseList, parseUpdate } from './wire.ts';

it.each(['coffee', 'tea', 'beverage', 'dessert'])('accepts %s on menu writes and reads', value => {
  expect(parseCreate({ name: 'Menu', category: value, price: 4200 })).toMatchObject({ input: { category: value } });
  expect(parseUpdate({ category: value, expectedRevision: 1 }, 'id')).toMatchObject({ patch: { category: value } });
  expect(parseList({ category: value }).category).toBe(value);
});

it('normalizes the old command value and keeps seasonal outside the category enum', () => {
  expect(category('drink')).toBe('beverage');
  expect(() => category('seasonal')).toThrow('CATEGORY_INVALID');
});
