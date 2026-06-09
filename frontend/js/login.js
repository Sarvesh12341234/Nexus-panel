async function checkAuth() {
  try {
    const response = await fetch('/api/me', { method: 'GET' });
    if (response.ok) {
      window.location.href = '/index.html';
    }
  } catch (error) {
    // Not logged in, stay on login page
  }
}

async function checkSetup() {
  try {
    const response = await fetch('/api/bootstrap', { method: 'GET' });
    const data = await response.json();
    if (data.needsSetup) {
      document.getElementById('setupNotice').hidden = false;
    }
  } catch (error) {
    console.error('Failed to check setup status:', error);
  }
}

async function handleLogin(event) {
  event.preventDefault();
  
  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;
  const errorMsg = document.getElementById('errorMsg');
  const submitBtn = event.target.querySelector('button[type="submit"]');

  if (!email || !password) {
    errorMsg.textContent = 'Please enter email and password.';
    errorMsg.hidden = false;
    return;
  }

  try {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Logging in...';
    errorMsg.hidden = true;

    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
      credentials: 'include', // Important: include credentials for cookies
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Login failed');
    }

    // Login successful
    console.log('✅ Login successful, redirecting...');
    window.location.href = '/index.html';
  } catch (error) {
    console.error('Login error:', error);
    errorMsg.textContent = error.message || 'Login failed. Please try again.';
    errorMsg.hidden = false;
    submitBtn.disabled = false;
    submitBtn.textContent = 'Login';
  }
}

async function handleForgotPassword() {
  const errorMsg = document.getElementById('errorMsg');
  try {
    const email = prompt('Enter your NexusPanel account email:');
    if (!email) return;
    const request = await fetch('/api/password/forgot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const requestData = await request.json();
    if (!request.ok) throw new Error(requestData.error || 'OTP request failed');
    alert(requestData.message || 'OTP requested.');
    const otp = prompt('Enter the 6-digit OTP:');
    if (!otp) return;
    const password = prompt('Enter your new password (8+ chars):');
    if (!password) return;
    const reset = await fetch('/api/password/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, otp, password }),
    });
    const resetData = await reset.json();
    if (!reset.ok) throw new Error(resetData.error || 'Password reset failed');
    errorMsg.textContent = resetData.message || 'Password reset. You can log in now.';
    errorMsg.hidden = false;
  } catch (error) {
    errorMsg.textContent = error.message || 'Password reset failed.';
    errorMsg.hidden = false;
  }
}

document.getElementById('loginForm').addEventListener('submit', handleLogin);
document.getElementById('forgotPasswordBtn')?.addEventListener('click', handleForgotPassword);

// Check if already logged in
checkAuth();
checkSetup();
