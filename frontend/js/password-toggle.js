(() => {
  function enhancePasswordInputs(root = document) {
    const inputs = [
      ...(root.matches?.('input[type="password"]:not([data-password-enhanced])') ? [root] : []),
      ...(root.querySelectorAll?.('input[type="password"]:not([data-password-enhanced])') || []),
    ];
    for (const input of inputs) {
      if (!input.isConnected || input.closest('.password-input')) continue;
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

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => enhancePasswordInputs(), { once: true });
  } else {
    enhancePasswordInputs();
  }
  new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) enhancePasswordInputs(node);
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
})();
