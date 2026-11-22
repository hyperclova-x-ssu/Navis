import type { FeatureId, WidgetDetailProps, WidgetModule, WidgetPanelProps } from '../../../contracts';
import { useDomainState, useRealRetry } from '../../../data/react';
import { ManualMeasurementEntry } from './manual';
import { EnvironmentDetail, EnvironmentPanel, environmentAbnormal, type EnvironmentPort, type EnvironmentView } from './widget';
export { EnvironmentDetail, EnvironmentPanel } from './widget';
export type { EnvironmentPort, EnvironmentView } from './widget';

/** The shared composition supplies a hook backed by the current run's selectors and commands. */
export function createEnvironmentWidget(id: FeatureId, useEnvironment: () => { view: EnvironmentView; port: EnvironmentPort }): WidgetModule {
  function useBinding() {
    const { view, port } = useEnvironment();
    const state = useDomainState('cctv');
    const retry = useRealRetry('cctv');
    const manual = state.mode === 'http';
    return { view, port: manual ? { ...port, retry } : port, manual, stale: state.status === 'stale', loading: state.status === 'idle' || state.status === 'loading' };
  }
  const loadingText = '매장 환경을 불러오고 있어요';
  function Panel({ width, height }: WidgetPanelProps) {
    const { loading, ...binding } = useBinding();
    return loading ? <p role="status">{loadingText}</p> : <EnvironmentPanel {...binding} width={width} height={height} />;
  }
  function Detail({ detailRef }: WidgetDetailProps) {
    const { loading, manual, ...binding } = useBinding();
    return loading ? <p role="status">{loadingText}</p> : <EnvironmentDetail {...binding} focus={detailRef?.view} manual={manual} measurementEntry={<ManualMeasurementEntry manual={manual} />} />;
  }
  function useSummary() {
    const { view, loading, manual } = useBinding();
    if (loading) return loadingText;
    if (manual && view.status === 'empty') return '입력한 측정값이 없어요';
    if (view.status === 'error') return '매장 환경 정보를 불러오지 못했어요';
    if (view.status === 'empty') return '연결된 센서가 없어요';
    const music = view.music.deviceStatus === 'connected' ? view.music.playing ? '재생 중' : '일시정지' : '연결된 음악 장치가 없어요';
    return [`현재 온도 ${view.current.temperature.toFixed(1)}°C · 현재 습도 ${view.current.humidity}%`, music, environmentAbnormal(view)].filter(Boolean).join(', ');
  }
  return { id, Panel, Detail, useSummary };
}
