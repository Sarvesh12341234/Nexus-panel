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

document.getElementById('loginForm').addEventListener('submit', handleLogin);

// Check if already logged in
checkAuth();
checkSetup();
