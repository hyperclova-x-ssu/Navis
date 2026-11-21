import type { FeatureId, WidgetDetailProps, WidgetModule, WidgetPanelProps } from '../../../contracts';
import { EnvironmentDetail, EnvironmentPanel, environmentAbnormal, type EnvironmentPort, type EnvironmentView } from './widget';
export { EnvironmentDetail, EnvironmentPanel } from './widget';
export type { EnvironmentPort, EnvironmentView } from './widget';

/** The shared composition supplies a hook backed by the current run's selectors and commands. */
export function createEnvironmentWidget(id: FeatureId, useEnvironment: () => { view: EnvironmentView; port: EnvironmentPort }): WidgetModule {
  function Panel(props: WidgetPanelProps) { const { view, port } = useEnvironment(); return <EnvironmentPanel view={view} port={port} width={props.width} height={props.height} />; }
  function Detail({ detailRef }: WidgetDetailProps) { const { view, port } = useEnvironment(); return <EnvironmentDetail view={view} port={port} focus={detailRef?.view} />; }
  function useSummary() { const { view } = useEnvironment(); return view.status === 'error' ? '매장 환경 정보를 불러오지 못했어요' : view.status === 'empty' ? '연결된 센서가 없어요' : `현재 온도 ${view.current.temperature.toFixed(1)}°C · 현재 습도 ${view.current.humidity}%, ${view.music.deviceStatus === 'connected' && view.music.playing ? '재생 중' : '일시정지'}${environmentAbnormal(view) ? `, ${environmentAbnormal(view)}` : ''}`; }
  return { id, Panel, Detail, useSummary };
}
