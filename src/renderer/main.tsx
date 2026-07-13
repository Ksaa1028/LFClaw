import React from 'react';
import ReactDOM from 'react-dom/client';
import { Provider } from 'react-redux';
import { store } from './store';
import App from './App';
import './index.css';

const electronBridge = (window as any).electron;
if (!electronBridge) {
  (window as any).electron = {
    platform: navigator.platform.toLowerCase().includes('mac') ? 'darwin' : 'win32',
    arch: 'x64',
  };
} else {
  electronBridge.platform ||= navigator.platform.toLowerCase().includes('mac') ? 'darwin' : 'win32';
  electronBridge.arch ||= 'x64';
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Failed to find the root element');
}

try {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <Provider store={store}>
        <App />
      </Provider>
    </React.StrictMode>
  );
} catch (error) {
  console.error('Failed to render the app:', error);
}
