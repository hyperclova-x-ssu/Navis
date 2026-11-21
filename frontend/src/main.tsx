import { createRoot } from 'react-dom/client';
import { BrowserApp } from './app/BrowserApp';
const root=document.getElementById('root');
if(!root)throw new Error('앱 진입 영역을 찾지 못했어요');
createRoot(root).render(<BrowserApp/>);
