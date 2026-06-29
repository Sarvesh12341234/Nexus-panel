(() => {
  function enhancePasswordInputs(root = document) {
    for (const input of root.querySelectorAll?.('input[type="password"]:not([data-password-enhanced])') || []) {
      input.dataset.passwordEnhanced = 'true';
      const wrapper = document.createElement('span');
      wrapper.className = 'password-input';
      input.parentNode.insertBefore(wrapper, input);
      wrapper.appendChild(input);

      const button = document.createElement('button');
      button.className = 'password-eye';
      button.type = 'button';
      button.setAttribute('aria-label', 'Show password');
      button.setAttribute('aria-pressed', 'false');
      button.title = 'Show password';
      button.innerHTML = '<span class="password-eye-icon" aria-hidden="true"></span>';
      wrapper.appendChild(button);
    }
  }

  document.addEventListener('click', (event) => {
    const button = event.target.closest('.password-eye');
    if (!button) return;
    const input = button.closest('.password-input')?.querySelector('input');
    if (!input) return;
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    button.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
    button.setAttribute('aria-pressed', String(!showing));
    button.title = showing ? 'Show password' : 'Hide password';
  });

  enhancePasswordInputs();
  new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) enhancePasswordInputs(node);
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
})();
