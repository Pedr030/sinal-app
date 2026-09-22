import { app, desktopCapturer } from 'electron';
app.whenReady().then(async () => {
  const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
  sources.forEach((s) => console.log(JSON.stringify({ id: s.id, name: s.name, display_id: s.display_id })));
  app.quit();
});
