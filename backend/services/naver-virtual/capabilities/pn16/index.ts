import type { PersonaCapability } from '../../app.ts'
import { registerCommerce } from './commerce.ts'
import { migration, seed } from './data.ts'
import { registerStorage } from './object-storage.ts'

export const personaCapability: PersonaCapability = {
  id: 'pn16',
  migrations: [migration],
  seed,
  register(app, context) {
    registerStorage(app, context)
    registerCommerce(app, context)
  },
}
