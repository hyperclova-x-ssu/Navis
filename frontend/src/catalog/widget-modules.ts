import type { WidgetModule } from '../contracts';
import { getRegistration } from './index';

export type WidgetFolderModules = Readonly<Record<string, { readonly widgets?: readonly WidgetModule[] } | undefined>>;

/** Same validation for the eager glob and independent contract fixtures. */
export function collectWidgetModules(folders: WidgetFolderModules): readonly WidgetModule[] {
  const seen = new Map<string, string>();
  const modules: WidgetModule[] = [];
  for (const path of Object.keys(folders).sort()) {
    const widgets = folders[path]?.widgets;
    if (!widgets) continue;
    for (const module of widgets) {
      if (!getRegistration(module.id)) throw new Error(`Widget module "${module.id}" (${path}) is not in the widget registry`);
      const first = seen.get(module.id);
      if (first !== undefined) throw new Error(`Widget module "${module.id}" is exported twice (${first}, ${path})`);
      seen.set(module.id, path);
      modules.push(module);
    }
  }
  return Object.freeze(modules);
}
