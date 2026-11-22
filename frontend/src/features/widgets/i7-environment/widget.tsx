import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ActionButton, ChipChoice, Icon, MetricFit, MiniChart, PanelState, StatusChip, Table } from '../../../ui';
import { usePanelChrome } from '../../../ui/panel-chrome';
import { FitProbe } from '../mgmt-money/fit';
import { DropletIcon, ThermometerIcon, TurntableArt } from './art';
import './widget.css';

type Music = { deviceStatus: 'connected' | 'disconnected'; playing: boolean; volumePct: number; track: string; playlistId: string; playlists: readonly { playlistId: string; name: string }[] };
export type EnvironmentView = { status: 'empty' } | { status: 'error' } | { status: 'ready'; sensorStatus: 'connected' | 'disconnected' | 'manual'; current: { temperature: number; humidity: number }; lastMeasuredAt: string; ranges: { temperature: readonly [number, number]; humidity: readonly [number, number] }; trend: readonly { time: string; temperature: number; humidity: number }[]; music: Music };
type Ready = Extract<EnvironmentView, { status: 'ready' }>;
type ControlResult = void | { ok: boolean; reason?: string };
export type EnvironmentPort = { setPlaying(playing: boolean): ControlResult; skipTrack(direction: 'previous' | 'next'): ControlResult; setVolume(volumePct: number): ControlResult; selectPlaylist(playlistId: string): ControlResult; retry(): void };
const outOfRange = (view: Ready, kind: 'temperature' | 'humidity') => view.current[kind] < view.ranges[kind][0] || view.current[kind] > view.ranges[kind][1];
export const environmentAbnormal = (view: Ready) => view.sensorStatus === 'disconnected' ? '연결 끊김 · 센서 확인 필요' : outOfRange(view, 'temperature') || outOfRange(view, 'humidity') ? '적정 범위 벗어남' : '';
const emptyMusic: Music = { deviceStatus: 'disconnected', playing: false, volumePct: 0, track: '', playlistId: '', playlists: [] };

/** DS 19.8: the abnormal chips are the kit StatusChip (28, caption 16 700); the 1x1 status box is the only local shape (80x84, text 15/20). */
function Status({ view, block = false, single = false }: { view: Ready; block?: boolean; single?: boolean }) {
  if (!environmentAbnormal(view)) return null;
  const disconnected = view.sensorStatus === 'disconnected';
  if (block) return <div role="status" className="i7-environment-status i7-environment-status-block">
    <span data-tone={disconnected ? 'danger' : 'warning'}><span aria-hidden="true">{disconnected ? '⊘' : '⚠'}</span>{disconnected ? '연결 끊김' : '적정 범위 벗어남'}</span>
  </div>;
  return <div role="status" className="i7-environment-status">
    {disconnected ? <StatusChip tone="danger">연결 끊김</StatusChip> : <StatusChip tone="warning">적정 범위 벗어남</StatusChip>}
    {disconnected && !single && <StatusChip tone="warning">센서 확인 필요</StatusChip>}
  </div>;
}
function ClimateReadout({ view, kind, variant, status = false, range = false }: { view: Ready; kind: 'temperature' | 'humidity'; variant: 'row' | 'stack' | 'tile'; status?: boolean; range?: boolean }) {
  const temperature = kind === 'temperature';
  const value = temperature ? view.current.temperature.toFixed(1) : String(view.current.humidity);
  const unit = temperature ? '°C' : '%';
  const label = temperature ? view.sensorStatus === 'manual' ? '온도' : '현재 온도' : view.sensorStatus === 'manual' ? '습도' : '현재 습도';
  const tone = view.sensorStatus === 'disconnected' ? 'stale' : outOfRange(view, kind) ? 'warning' : undefined;
  const icon = temperature ? <ThermometerIcon /> : <DropletIcon />;
  return <div className="i7-climate" data-variant={variant} data-tone={tone} role="group" aria-label={`${label} ${value}${unit}`}>
    {variant !== 'stack' && <span className="i7-climate-icon">{icon}</span>}
    <MetricFit value={value} unit={unit} stacked={false} presentation={variant === 'row' ? undefined : 'hero'} />
    {variant !== 'row' && <p className="i7-climate-label">{variant === 'stack' && icon}{label}</p>}
    {(variant === 'tile' || range) && <p className="i7-climate-range">적정 {temperature ? view.ranges.temperature.map(n => n.toFixed(1)).join('~') : view.ranges.humidity.join('~')}{unit}</p>}
    {status && <Status view={view} />}
  </div>;
}
/** The music controls keep their own keys (arrows move the slider and chips, Enter/Space press) away from the panel and page key handlers.
 *  Esc is the one key that has to travel up: once focus sat on a chip, the window never saw it and could not be closed with Esc (BUG-004). */
const keepControlKeys = (event: KeyboardEvent<HTMLElement>) => { if (event.key !== 'Escape') event.stopPropagation(); };

function TransportIcon({ kind }: { kind: 'previous' | 'next' | 'play' | 'pause' }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true" width="24" height="24" fill="currentColor">{kind === 'pause' ? <path d="M6 4h4v16H6zM14 4h4v16h-4z" /> : kind === 'play' ? <path d="m7 4 13 8-13 8z" /> : kind === 'previous' ? <path d="M4 4h3v16H4zm16 0L8 12l12 8z" /> : <path d="M17 4h3v16h-3zM4 4l12 8-12 8z" />}</svg>;
}
function Player({ music, port, detail = false, controls = true, volume = false, playlists = false, playlistNameOnly = false, artist = false, hidden = false }: { music: Music; port: EnvironmentPort; detail?: boolean; controls?: boolean; volume?: boolean; playlists?: boolean; playlistNameOnly?: boolean; artist?: boolean; hidden?: boolean }) {
  const [error, setError] = useState('');
  const invoke = (run: () => ControlResult) => {
    if (hidden || music.deviceStatus !== 'connected') return;
    const result = run();
    setError(result && !result.ok ? result.reason === 'DEVICE_UNAVAILABLE' ? '연결된 음악 장치가 없어요' : '매장 환경 정보를 불러오지 못했어요' : '');
  };
  const disabled = music.deviceStatus !== 'connected';
  const playing = !disabled && music.playing;
  const [title, ...byline] = music.track.split(' · ');
  const titleBreak = title.lastIndexOf(' ');
  return <div className="i7-environment-player" data-detail={detail || undefined}>
    <div className="i7-environment-art"><TurntableArt playing={playing && !error} detail={detail} /></div>
    <div className="i7-environment-now">
      {disabled ? <p>{detail ? '음악 장치를 연결하면 바로 재생할 수 있어요' : '연결된 음악 장치가 없어요'}</p> : <>
        <p className="i7-environment-track" aria-label={`현재 재생 곡: ${music.track}`}>{titleBreak > 0 ? <>{title.slice(0, titleBreak)}<span className="i7-environment-track-tail">{' '}{title.slice(titleBreak + 1)}</span></> : title}</p>
        {artist && byline.length > 0 && <p className="i7-environment-artist">{byline.join(' · ')}</p>}
        <p className="i7-environment-music-state"><span aria-hidden="true">{playing ? '▶' : '‖'}</span>{playing ? '재생 중' : '일시정지'}</p>
      </>}
      {controls && !disabled && <div className="i7-environment-control-scope" inert={hidden || undefined} aria-hidden={hidden || undefined} data-hidden={hidden || undefined} onPointerDown={event => event.stopPropagation()} onPointerUp={event => event.stopPropagation()} onPointerCancel={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onKeyDown={keepControlKeys}>
        <div className="i7-environment-controls">
          <ActionButton variant="secondary" aria-label="이전 곡" onClick={() => invoke(() => port.skipTrack('previous'))}><TransportIcon kind="previous" /></ActionButton>
          <ActionButton className="i7-environment-play" aria-label={playing ? '일시정지' : '재생'} onClick={() => invoke(() => port.setPlaying(!music.playing))}><TransportIcon kind={playing ? 'pause' : 'play'} /></ActionButton>
          <ActionButton variant="secondary" aria-label="다음 곡" onClick={() => invoke(() => port.skipTrack('next'))}><TransportIcon kind="next" /></ActionButton>
        </div>
        {volume && <label className="i7-environment-volume">음량 <input aria-label="음량 조절" type="range" min="0" max="100" value={music.volumePct} onChange={event => invoke(() => port.setVolume(Number(event.currentTarget.value)))} /><span>{music.volumePct}%</span></label>}
        {playlists && <div className="i7-environment-playlists"><ChipChoice label="재생목록" value={music.playlistId} onChange={playlistId => invoke(() => port.selectPlaylist(playlistId))} options={music.playlists.map(playlist => ({ value: playlist.playlistId, label: playlist.name }))} /></div>}
      </div>}
      {playlistNameOnly && !disabled && <p className="i7-environment-artist">{music.playlists.find(playlist => playlist.playlistId === music.playlistId)?.name}</p>}
      {error && !disabled && <p role="alert">{error}</p>}
    </div>
  </div>;
}
function Trend({ view, detail = false }: { view: Ready; detail?: boolean }) {
  return <div className="i7-environment-trend" data-detail={detail || undefined} aria-label={view.trend.length >= 2 ? "시간대별 변화" : "측정 기록"}><h4>{view.trend.length >= 2 ? "시간대별 변화" : "측정 기록"}</h4>
    {view.trend.length >= 2 && <div className="i7-environment-charts">{(['temperature', 'humidity'] as const).map(kind => <div className="i7-environment-trend-row" data-kind={kind} key={kind}><p>{kind === 'temperature' ? '온도' : '습도'}</p><MiniChart kind="line" compact seriesKeys={[kind === 'temperature' ? 'morning' : 'secondary']} data={{ axisLabels: view.trend.map(row => row.time), series: [{ name: kind === 'temperature' ? '온도' : '습도', unit: kind === 'temperature' ? '°C' : '%', values: view.trend.map(row => row[kind]) }] }} />{detail && <strong>{kind === 'temperature' ? `${view.current.temperature.toFixed(1)}°C` : `${view.current.humidity}%`}</strong>}</div>)}</div>}
    {detail && view.trend.length >= 2 && <div className="i7-environment-trend-axis" aria-hidden="true"><span>{view.trend[0]?.time}</span><span>{view.trend.at(-1)?.time}</span></div>}
    {detail && <Table className="i7-environment-table"><thead><tr><th scope="col">시간</th><th scope="col" data-numeric="true">온도</th><th scope="col" data-numeric="true">습도</th></tr></thead><tbody>{view.trend.map(row => <tr key={row.time}><th scope="row">{row.time}</th><td data-numeric="true">{row.temperature.toFixed(1)}°C</td><td data-numeric="true">{row.humidity}%</td></tr>)}</tbody></Table>}
  </div>;
}
const measured = (view: Ready) => `${view.sensorStatus === 'manual' ? '직접 측정' : '마지막 측정'} ${view.lastMeasuredAt}`;

export function EnvironmentDetail({ view, port, focus, measurementEntry, manual, stale }: { view: EnvironmentView; port: EnvironmentPort; focus?: string; measurementEntry?: ReactNode; manual?: boolean; stale?: boolean }) {
  // N19 deep link: a chat hand-off scrolls the named section ('sensor' or 'player') into view.
  const target = useRef<HTMLElement | null>(null);
  useEffect(() => { if (focus === 'sensor' || focus === 'player') target.current?.scrollIntoView?.({ block: 'start' }); }, [focus]);
  if (view.status === 'error') return <div className="i7-environment-state" lang="ko">
    <Icon name="error" className="i7-environment-state-icon" />
    <p role="alert">매장 환경 정보를 불러오지 못했어요</p>
    <ActionButton onClick={port.retry}>다시 시도하기</ActionButton>
  </div>;
  return <div className="i7-environment-detail" lang="ko">
    <section ref={focus === 'sensor' ? target : undefined} data-focus={focus === 'sensor' || undefined} className="i7-environment-section" role="group" aria-label="온도와 습도"><h3>환경 모니터링</h3>
      {stale && <p role="status">마지막으로 불러온 측정값이에요 <ActionButton variant="secondary" onClick={port.retry}>다시 불러오기</ActionButton></p>}
      {view.status === 'empty' ? manual ? <p>입력한 측정값이 없어요</p> : <><p>연결된 센서가 없어요</p><p className="i7-environment-next">센서를 연결하면 온도와 습도가 여기에 보여요</p></> : <>
        {view.sensorStatus === 'disconnected' && <Status view={view} />}
        <div className="i7-environment-readings"><ClimateReadout view={view} kind="temperature" variant="tile" status={view.sensorStatus === 'connected' && outOfRange(view, 'temperature')} /><ClimateReadout view={view} kind="humidity" variant="tile" status={view.sensorStatus === 'connected' && !outOfRange(view, 'temperature') && outOfRange(view, 'humidity')} /></div>
        <p className="i7-environment-measured">{measured(view)}</p><Trend view={view} detail />
      </>}
      {measurementEntry}
    </section>
    <section ref={focus === 'player' ? target : undefined} data-focus={focus === 'player' || undefined} className="i7-environment-section" role="group" aria-label="매장 음악"><h3>매장 음악 관리</h3><Player music={view.status === 'ready' ? view.music : emptyMusic} port={port} detail volume playlists artist /></section>
  </div>;
}
export function EnvironmentPanel({ view, port, width, height, manual, stale }: { view: EnvironmentView; port: EnvironmentPort; width: number; height: number; manual?: boolean; stale?: boolean }) {
  const chrome = usePanelChrome();
  if (view.status === 'error') return <PanelState tone="error" message="매장 환경 정보를 불러오지 못했어요" shortMessage={height === 1 && width <= 2 ? '불러오지 못했어요' : undefined} action={{ label: '다시 시도하기', widgetName: '매장 환경', onPress: port.retry }} />;
  const small = width === 1 && height === 1;
  const shortColumn = width === 1 && height === 2;
  const abnormal = view.status === 'ready' && Boolean(environmentAbnormal(view));
  const row = height === 1 || shortColumn;
  const showChart = (width >= 3 && height >= 3) || (width === 4 && height >= 2);
  /** D-333: from 3x3 up the panel also lists every reading of the trend and the allowed range under each value (the reverse of the drop order). */
  const large = width >= 3 && height >= 3;
  return <div className="i7-environment-panel" data-width={width} data-height={height} data-abnormal={abnormal || undefined} lang="ko">
    <div className="i7-environment-climate-half" role="group" aria-label="온도와 습도">{view.status === 'empty' ? <><p>{manual ? '입력한 측정값이 없어요' : '연결된 센서가 없어요'}</p>{!manual && !small && <p className="i7-environment-next">센서를 연결하면 온도와 습도가 여기에 보여요</p>}</> : <>
      <div className="i7-environment-readings"><ClimateReadout view={view} kind="temperature" variant={row ? 'row' : 'stack'} range={large} /><ClimateReadout view={view} kind="humidity" variant={row ? 'row' : 'stack'} range={large} /></div>
      {!small && (abnormal ? <Status view={view} single={(width === 2 && height === 1) || (width === 1 && height === 2)} /> : !shortColumn && <p className="i7-environment-measured">{measured(view)}</p>)}
      {((width === 2 && height >= 3) || (width === 1 && height === 4)) && <div className="i7-environment-trend-rows"><h4>시간대별 변화</h4>{view.trend.slice(-(height === 3 ? 3 : 5)).map(item => <div className="i7-environment-value-row" key={item.time}><span>{item.time}</span><strong>{item.temperature.toFixed(1)}°C · {item.humidity}%</strong></div>)}</div>}
      {showChart && view.trend.length >= 2 && <Trend view={view} />}
      {large && view.trend.length > 0 && <div className="i7-environment-large-rows" role="list" aria-label="시간대별 변화">{[...view.trend].reverse().map(item => <div className="i7-environment-value-row" role="listitem" key={item.time}><span>{item.time}</span><strong>{item.temperature.toFixed(1)}°C · {item.humidity}%</strong></div>)}</div>}
    </>}{stale && !small && <p role="status" className="i7-environment-next">마지막으로 불러온 측정값이에요</p>}</div>
    <div className="i7-environment-divider" aria-hidden="true" />
    <div className="i7-environment-music-half" role="group" aria-label="매장 음악">{small && abnormal && view.status === 'ready' ? <Status view={view} block /> : <Player music={view.status === 'ready' ? view.music : emptyMusic} port={port} controls={height > 1 || width >= 3} volume={(width === 1 && height === 4) || (width === 2 && height >= 3) || (width >= 3 && height >= 2)} playlists={showChart} playlistNameOnly={width === 2 && height === 4} artist={width >= 2 && height >= 2} hidden={chrome.editing || chrome.waiting} />}</div>
    <FitProbe order={[{ selector: '.i7-environment-large-rows .i7-environment-value-row', last: true }, { selector: '.i7-climate-range' }, { selector: '.i7-environment-next' }, { selector: '.i7-environment-artist' }, { selector: '.i7-environment-volume' }, { selector: '.i7-environment-measured' }, { selector: '.i7-environment-track-tail' }, ...(small ? [{ selector: '.i7-environment-art' }] : [])]} deps={[width, height, view.status, abnormal]} />
  </div>;
}
