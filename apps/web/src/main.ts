import { mount } from 'svelte';
import './app.css';
import App from './App.svelte';

const target = document.getElementById('app') ?? document.body;

export default mount(App, { target });

/*
 * Registers the service worker that lets the app be installed to the home
 * screen. Only in a production build: the dev server reloads modules itself, and
 * a worker would only be in the way there.
 */
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js');
  });
}
