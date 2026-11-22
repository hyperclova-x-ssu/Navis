import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { renderWithKit } from '../../../ui/test-utils';
import { CustomerAnalysisDetail, CustomerAnalysisPanel } from './customer-analysis';
const host = { layer: 'management' as const, resetPreview: vi.fn(), openLinked: vi.fn(), openDetail: vi.fn(), notify: vi.fn(), acknowledgeBriefing: vi.fn(), openClosing: vi.fn(() => true) };
const common = { featureId:'customer-analysis' as const, condition:{kind:'default' as const}, host };
afterEach(cleanup);
it('shows the café playback and keeps the camera status and analysis in the example detail',()=>{
 const {container}=renderWithKit(<CustomerAnalysisDetail {...common} detailRef={{featureId:'customer-analysis'}}/>);
 expect(container.querySelector('video')).toHaveAttribute('src','/cnn/store-sample.mp4');
 expect(screen.getByRole('button',{name:/재생/})).toBeInTheDocument();
 expect(screen.getByTestId('now-instore')).toBeInTheDocument();
 expect(screen.getByRole('grid',{name:'CCTV 상태'})).toBeInTheDocument();
 expect(screen.getByText('매장 분석')).toBeInTheDocument();
 expect(container.querySelector('.mc-camera-stills')).not.toBeInTheDocument();
 // 연결 상태·작동 상태 are 28-high status chips (colour + icon + words), words follow AC-1074 (녹화 중).
 const grid = screen.getByRole('grid', { name: 'CCTV 상태' });
 expect(grid.compareDocumentPosition(container.querySelector('video')!) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
 expect(within(grid).getAllByText('연결됨').map(el => el.closest('.ui-status-chip'))).toHaveLength(1);
 for (const chip of within(grid).getAllByText('녹화 중').map(el => el.closest('.ui-status-chip'))) expect(chip).toHaveAttribute('data-semantic', 'done');
 expect(within(grid).queryByText('작동 중')).toBeNull();
});
it('reports the disconnected camera in the example',()=>{renderWithKit(<CustomerAnalysisPanel {...common} width={1} height={1} shape="Q" presetId="A" editing={false}/>,{preview:{family:'normal',overrides:{'customer-analysis':'camera-disconnected'}}});expect(screen.getByText('지금 숫자 · 1대 확인 필요')).toBeInTheDocument();}); // 1x1: the label is never dropped, so the warning rides on it (D-323: the label is the headcount's)
it('on a 2x2 panel the camera warning rides on the headcount label (never dropped before it), while the visits line is the first to go and the normal chip goes next (AC-1075, D-323)',()=>{
 const rank=(el:HTMLElement)=>Number(el.closest('[data-drop]')!.getAttribute('data-drop')); // the higher the rank, the earlier it is dropped
 const warn=renderWithKit(<CustomerAnalysisPanel {...common} width={2} height={2} shape="S" presetId="A" editing={false}/>,{preview:{family:'normal',overrides:{'customer-analysis':'camera-disconnected'}}});
 expect(rank(screen.getByText('지금 숫자 · 1대 확인 필요'))).toBeLessThan(rank(screen.getByText(/^방문 감지 \d+건$/)));
 warn.unmount();
 renderWithKit(<CustomerAnalysisPanel {...common} width={2} height={2} shape="S" presetId="A" editing={false}/>);
 expect(rank(screen.getByText(/^방문 감지 \d+건$/))).toBeGreaterThan(rank(screen.getByText(/카메라 \d+대 정상/)));
 expect(rank(screen.getByText(/카메라 \d+대 정상/))).toBeGreaterThan(rank(screen.getByText('지금 숫자')));
});
it.each([
 ['ko', '카메라 1대 정상'],
 ['en', '1 camera is working'],
 ['zh-Hans', '1 台摄像头正常'],
 ['zh-Hant', '1 台攝影機正常'],
] as const)('describes a single example camera in %s', (locale, label) => {
 renderWithKit(<CustomerAnalysisPanel {...common} width={1} height={1} shape="Q" presetId="A" editing={false}/>, { locale });
 expect(screen.getByText(label)).toBeInTheDocument();
});
it('names the disconnected camera and keeps the count without displaying footage or boxes', () => {
 renderWithKit(<CustomerAnalysisDetail {...common} detailRef={{ featureId: 'customer-analysis' }} />, { preview: { family: 'normal', overrides: { 'customer-analysis': 'camera-disconnected' } } });
 const grid = screen.getByRole('grid', { name: 'CCTV 상태' });
 const off = within(grid).getByText('연결 끊김');
 expect(off.closest('.ui-status-chip')).toHaveAttribute('data-semantic', 'warning'); // ⚠ + words, not colour alone
 const name = off.closest('[role="row"]')!.querySelector('[role="gridcell"]')!.textContent!.trim();
 expect(screen.getByText(`${name} 카메라 연결이 끊겨서 숫자가 실제보다 적을 수 있어요`)).toBeVisible();
 const footage = screen.getByRole('region', { name: '카메라 화면' });
 const stage = within(footage).getByText('연결이 끊겨 화면을 볼 수 없어요').closest('.cctv-stage');
 expect(stage).toBeVisible();
 expect(footage.querySelector('video, .cctv-overlay, .cctv-box')).not.toBeInTheDocument();
 expect(within(footage).getByTestId('now-instore')).toHaveTextContent('5명');
 expect(within(footage).getByTestId('now-change')).toHaveTextContent(/▼\s*1명/);
});
it('aligns hourly visit and staff numbers and headers to the right at 125% text size', () => {
 const css = readFileSync('src/features/widgets/mgmt-customers/widgets.css', 'utf8');
 renderWithKit(<><style>{css}</style><CustomerAnalysisDetail {...common} detailRef={{ featureId: 'customer-analysis' }} /></>, { textScale: 125 });
 const table = screen.getByRole('table', { name: '시간대별 방문과 근무 인원' });
 const headers = within(table).getAllByRole('columnheader');
 expect(headers.map(cell => cell.textContent)).toEqual(['시간', '방문', '근무', '상태']);
 for (const row of within(table).getAllByRole('row')) {
  expect(Array.from(row.children, cell => getComputedStyle(cell).textAlign)).toEqual(['start', 'end', 'end', 'start']);
 }
});
it('shows the video failure message and fixed scene numbers in the example detail',()=>{
 const {container}=renderWithKit(<CustomerAnalysisDetail {...common} detailRef={{featureId:'customer-analysis'}}/>);
 const video=container.querySelector('video');
 expect(video).not.toBeNull();
 fireEvent.error(video!);
 expect(screen.getByText('영상을 불러오지 못했어요')).toBeInTheDocument();
 expect(screen.getByRole('button',{name:'다시 불러오기'})).toBeInTheDocument();
 expect(screen.getByTestId('now-instore')).toHaveTextContent('5명');
});
