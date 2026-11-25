/**
 * Registration is closed: while <html> carries class="reg-closed", every way
 * into registering opens this notice instead.
 *
 * Loaded before app.js and chat.js so it acts first: a link to #register is
 * turned back to the page, /chat does not open its assistant, and a tap on
 * anything marked data-reg-closed (or the old Proceed button, if a cached
 * page still has it) opens the notice. The server refuses registrations on
 * its own as well (lib/registration.js); this is only what people see.
 */
const FB_POST = 'https://www.facebook.com/share/p/1DSRhQ7qCA/';
const closed = document.documentElement.classList.contains('reg-closed');

if (closed) {
  // A shared link straight to the form lands on the information page.
  if (location.hash === '#register') history.replaceState(null, '', location.pathname + location.search);
  // /chat would open the registration assistant by itself.
  const chatPage = document.body.hasAttribute('data-chat-open');
  document.body.removeAttribute('data-chat-open');

  const dialog = document.createElement('dialog');
  dialog.className = 'rc-dialog';
  dialog.setAttribute('aria-labelledby', 'rc-h');
  dialog.innerHTML = `
    <div class="rc-card">
      <div class="rc-icon" aria-hidden="true">🔒</div>
      <h2 id="rc-h">Registration is closed</h2>
      <p>Online registration for the Southville Run For A Cause 2026 has ended. Thank you for your support!</p>
      <p><strong>No late or walk-in registrations</strong> will be accepted.</p>
      <p><strong>Already registered?</strong> Claim your race kit on <strong>Nov 25–27, 8 AM – 5 PM</strong> at the Tropical Building, Gate 13. Bring your confirmation email.</p>
      <p>📢 Please wait for announcements on the <a href="${FB_POST}" target="_blank" rel="noopener">official Southville Facebook page</a>.</p>
      <div class="rc-actions">
        <a class="btn" href="/#claiming" data-rc-info>See race kit claiming details</a>
        <button type="button" class="rc-close" data-rc-close>Close</button>
      </div>
    </div>`;
  document.body.append(dialog);

  const show = () => { if (!dialog.open) dialog.showModal(); };
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog || e.target.closest('[data-rc-close]')) dialog.close();
    if (e.target.closest('[data-rc-info]') && location.pathname === '/') dialog.close();
  });

  // Capture, on the document, before any other handler: nothing behind a
  // closed door gets to run.
  document.addEventListener('click', (e) => {
    if (!e.target.closest?.('[data-reg-closed], #proceed, .cb-launch, #cb-start')) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    show();
  }, true);

  if (chatPage) show();
}
