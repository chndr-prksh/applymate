// Shows the tailored resume that was attached for a job.
(async () => {
  const key = new URLSearchParams(location.search).get('k');
  // Copies kept with the tracker live in permanent storage; this session's previews in session storage.
  const file = (await chrome.storage.local.get(key))[key] || (await chrome.storage.session.get(key))[key];
  if (!file) {
    document.body.append(Object.assign(document.createElement('p'), { textContent: 'This tailored resume is no longer available. Fill the form again to rebuild it.' }));
    return;
  }
  const bytes = Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0));
  const frame = document.createElement('iframe');
  frame.src = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  document.body.append(frame);
})();
