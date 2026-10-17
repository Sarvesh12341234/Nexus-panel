const params = new URLSearchParams(window.location.search);
const token = params.get('token') || '';
const form = document.getElementById('setupForm');
const errorMsg = document.getElementById('errorMsg');
const submitBtn = form.querySelector('button[type="submit"]');

function showError(message) {
  errorMsg.textContent = message;
  errorMsg.hidden = false;
}

async function verifySetupState() {
  if (!token) {
    showError('This setup link is incomplete. Use the setup URL printed by the installer.');
    submitBtn.disabled = true;
    return false;
  }
  try {
    const response = await fetch('/api/bootstrap', { credentials: 'same-origin' });
    const data = await response.json();
    if (!data.needsSetup) {
      window.location.replace('/login.html');
      return false;
    }
    return true;
  } catch {
    showError('NexusPanel is not responding. Check the service and try again.');
    submitBtn.disabled = true;
    return false;
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorMsg.hidden = true;

  const name = document.getElementById('name').value.trim();
  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;
  const passwordConfirmation = document.getElementById('passwordConfirmation').value;

  if (name.length < 2) return showError('Enter an owner name.');
  if (!email.includes('@')) return showError('Enter a valid email address.');
  if (password.length < 12) return showError('Password must be at least 12 characters.');
  if (password !== passwordConfirmation) return showError('Passwords do not match.');

  submitBtn.disabled = true;
  submitBtn.textContent = 'Creating account...';
  try {
    const response = await fetch('/api/setup', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-NexusPanel-Request': '1',
        'X-NexusPanel-Setup-Token': token,
      },
      credentials: 'same-origin',
      body: JSON.stringify({ name, email, password, passwordConfirmation }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Account setup failed.');
    window.location.replace('/index.html');
  } catch (error) {
    showError(error.message || 'Account setup failed. Please try again.');
    submitBtn.disabled = false;
    submitBtn.textContent = 'Create owner account';
  }
});

verifySetupState();
