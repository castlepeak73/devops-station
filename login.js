const $ = selector => document.querySelector(selector);
const rememberedUsername = localStorage.getItem('devops-station-username');
if (rememberedUsername) $('#username').value = rememberedUsername;

let setupRequired = false;
let rememberedSession = false;
let sessionUsername = '';

document.addEventListener('click', event => {
  const inputId = event.target.dataset.passwordToggle;
  if (!inputId) return;
  const input = document.getElementById(inputId);
  input.type = input.type === 'password' ? 'text' : 'password';
  event.target.textContent = input.type === 'password' ? '显示' : '隐藏';
});

async function request(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) { const error = new Error(data.error || '请求失败'); error.fields = data.errors; throw error; }
  return data;
}

function clearFieldErrors() { ['username', 'display-name', 'password'].forEach(id => $(`#${id}-error`).textContent = ''); }
function showFieldErrors(errors = {}) {
  if (errors.username) $('#username-error').textContent = errors.username;
  if (errors.displayName) $('#display-name-error').textContent = errors.displayName;
  if (errors.password) $('#password-error').textContent = errors.password;
}

async function loadStatus() {
  const status = await request('/api/auth/status');
  if (status.user && status.rememberSession) {
    rememberedSession = true;
    sessionUsername = status.user.username;
    $('#username').value = status.user.username;
    $('#username').readOnly = false;
    $('#password-field').hidden = false;
    $('#password').value = 'remembered-session';
    $('#password').readOnly = true;
    $('[data-password-toggle="password"]').hidden = true;
    $('#remember-session').checked = true;
    localStorage.setItem('devops-station-remember-session', 'true');
    $('#login-title').textContent = `以 ${status.user.username} 登录`;
    $('#login-copy').textContent = '已记住登录状态，点击即可进入平台';
    return;
  }
  setupRequired = status.setupRequired;
  localStorage.removeItem('devops-station-remember-session');
  $('#display-name-field').hidden = !setupRequired;
  $('#display-name').required = setupRequired;
  $('#login-title').textContent = setupRequired ? '创建管理员账号' : '登录工作台';
  $('#login-copy').textContent = setupRequired ? '这是首次使用，请创建平台管理员' : '使用你的账号访问资产与巡检数据';
  $('#login-submit').textContent = setupRequired ? '创建并进入平台' : '登录';
}

$('#remember-session').addEventListener('change', async event => {
  if (event.target.checked) return;
  localStorage.removeItem('devops-station-remember-session');
  $('#password').value = '';
  $('#password').readOnly = false;
  $('[data-password-toggle="password"]').hidden = false;
  if (!rememberedSession) return;
  try {
    await request('/api/auth/logout', { method: 'POST' });
    rememberedSession = false;
    $('#username').readOnly = false;
    $('#password').readOnly = false;
    $('#password').value = '';
    $('[data-password-toggle="password"]').hidden = false;
    $('#login-title').textContent = '登录工作台';
    $('#login-copy').textContent = '请输入密码后登录平台';
  } catch (error) {
    event.target.checked = true;
    $('#login-error').textContent = error.message;
  }
});

$('#username').addEventListener('input', async event => {
  if (!rememberedSession || event.target.value.trim() === sessionUsername) return;
  rememberedSession = false;
  sessionUsername = '';
  localStorage.removeItem('devops-station-remember-session');
  $('#remember-session').checked = false;
  $('#password').value = '';
  $('#password').readOnly = false;
  $('[data-password-toggle="password"]').hidden = false;
  $('#login-title').textContent = '登录工作台';
  $('#login-copy').textContent = '请输入密码后登录平台';
  try { await request('/api/auth/logout', { method: 'POST' }); } catch (_) {}
});

$('#login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const error = $('#login-error'); const button = $('#login-submit');
  error.textContent = ''; clearFieldErrors(); button.disabled = true;
  const username = $('#username').value.trim();
  try {
    if (rememberedSession) return window.location.replace('/');
    const body = setupRequired
      ? { username, displayName: $('#display-name').value.trim(), password: $('#password').value }
      : { username, password: $('#password').value, remember: $('#remember-session').checked };
    await request(setupRequired ? '/api/auth/setup' : '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    localStorage.setItem('devops-station-username', username);
    if ($('#remember-session').checked || setupRequired) localStorage.setItem('devops-station-remember-session', 'true');
    else localStorage.removeItem('devops-station-remember-session');
    window.location.replace('/');
  } catch (err) { if (err.fields) showFieldErrors(err.fields); else error.textContent = err.message; }
  finally { button.disabled = false; }
});

loadStatus().catch(error => { $('#login-error').textContent = error.message; });
