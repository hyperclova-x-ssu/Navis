/** Test helper: drive the kit DateField and TimeField the way a person does (open the field, choose the day, choose the time). */
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

export const longDate = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('ko-KR', { timeZone: 'UTC', month: 'long', day: 'numeric', weekday: 'long' });
export async function pickDateTime(dateField: RegExp, timeField: RegExp, iso: string, time: string) {
  await userEvent.click(screen.getByRole('button', { name: dateField }));
  await userEvent.click(await screen.findByRole('button', { name: longDate(iso) }));
  await userEvent.click(screen.getByRole('button', { name: timeField }));
  await userEvent.click(await screen.findByRole('option', { name: time }));
}
