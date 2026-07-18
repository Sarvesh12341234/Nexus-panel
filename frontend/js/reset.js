const form = document.getElementById('resetForm');
const message = document.getElementById('resetMsg');
const sendButton = document.getElementById('sendResetCodeBtn');

function showMessage(text, isError = false) {
  message.textContent = text;
  message.hidden = false;
  message.dataset.type = isError ? 'error' : 'success';
}

async function requestJson(url, options) {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json', 'X-NexusPanel-Request': '1' },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Request failed.');
  return data;
}

sendButton.addEventListener('click', async () => {
  const email = form.email.value.trim();
  if (!email) {
    form.email.reportValidity();
    return;
  }
  sendButton.disabled = true;
  try {
    const data = await requestJson('/api/password/forgot', {
      method: 'POST',
      body: JSON.stringify({ email }),
    });
    showMessage(data.message || 'Reset code requested.');
    form.otp.focus();
  } catch (error) {
    showMessage(error.message, true);
  } finally {
    sendButton.disabled = false;
  }
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const submitButton = form.querySelector('[type="submit"]');
  submitButton.disabled = true;
  try {
    const data = await requestJson('/api/password/reset', {
      method: 'POST',
      body: JSON.stringify({
        email: form.email.value.trim(),
        otp: form.otp.value.trim(),
        password: form.password.value,
      }),
    });
    showMessage(data.message || 'Password reset. You can log in now.');
    window.setTimeout(() => {
      window.location.href = '/login.html';
    }, 1200);
  } catch (error) {
    showMessage(error.message, true);
  } finally {
    submitButton.disabled = false;
  }
});
