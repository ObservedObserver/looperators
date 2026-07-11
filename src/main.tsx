import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createFrameResizeObserverClass, type ResizeObserverConstructorLike } from '@shared/frame-resize-observer';
import './index.css';
import App from './App.tsx';

// React Flow and split-pane layout observers can synchronously resize each
// other during a dense panel transition. Browsers report that recoverable
// delivery deferral as a global error even though the next frame is correct.
// Put observer callbacks on the animation-frame boundary so layout settles
// before consumers measure again; real application errors remain untouched.
window.ResizeObserver = createFrameResizeObserverClass(
  window.ResizeObserver as unknown as ResizeObserverConstructorLike,
  (callback) => window.requestAnimationFrame(callback),
  (frameId) => window.cancelAnimationFrame(frameId),
) as unknown as typeof ResizeObserver;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
