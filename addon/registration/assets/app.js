let token = location.hash.slice(1);
const form = document.getElementById('registration');
const status = document.getElementById('status');
const error = document.getElementById('error');
const photo = document.getElementById('portrait');
const submit = document.getElementById('submit');
let previewUrl = '';
let submitting = false;

const request = async (action, data = {}, requestToken = token) => {
    const response = await fetch(`/register/api/${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: requestToken, ...data }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || 'Unable to complete registration. Please try again.');
    return result;
};
const showComplete = state => {
    form.hidden = true;
    status.hidden = true;
    document.getElementById('complete').hidden = false;
    document.getElementById('complete-title').textContent = 'Registration submitted';
    document.getElementById('complete-message').textContent = 'Your details have been sent to your administrator. They will assign your permissions and activate your account.';
    if (state === 'Approved') {
        document.getElementById('complete-title').textContent = 'Your account is ready';
        document.getElementById('complete-message').textContent = 'Your administrator has provisioned your account. You can now sign in to MES with your username and password.';
    }
    if (state === 'Rejected') {
        document.getElementById('complete-title').textContent = 'Registration closed';
        document.getElementById('complete-message').textContent = 'Your administrator did not approve this registration. Contact them for help.';
    }
};
photo.addEventListener('change', () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    const file = photo.files[0];
    const valid = file && ['image/jpeg', 'image/png', 'image/webp'].includes(file.type) && file.size <= 5 * 1024 * 1024;
    photo.setCustomValidity(file && !valid ? 'Choose a JPG, PNG or WebP image up to 5 MB.' : '');
    document.getElementById('preview').hidden = !valid;
    document.getElementById('photo-placeholder').hidden = Boolean(valid);
    if (valid) {
        previewUrl = URL.createObjectURL(file);
        document.getElementById('preview').src = previewUrl;
    }
    photo.reportValidity();
});
form.addEventListener('submit', async event => {
    event.preventDefault();
    if (submitting) return;
    error.hidden = true;
    if (document.getElementById('password').value !== document.getElementById('confirmPassword').value) {
        error.textContent = 'The passwords do not match.';
        error.hidden = false;
        return;
    }
    if (!form.reportValidity()) return;
    submitting = true;
    const activeToken = token;
    submit.disabled = true;
    submit.textContent = 'Submitting…';
    try {
        const portrait = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error('Unable to read your photo. Please select it again.'));
            reader.readAsDataURL(photo.files[0]);
        });
        const values = Object.fromEntries(new FormData(form));
        if (activeToken !== token) return;
        await request('submit', { ...values, portrait }, activeToken);
        if (activeToken !== token) return;
        form.reset();
        showComplete('Submitted');
    } catch (failure) {
        if (activeToken !== token) return;
        error.textContent = failure.message || 'Unable to connect. Please try again.';
        error.hidden = false;
        // A lost response may follow a successful submission. Check before allowing a retry.
        try {
            const current = await request('status', {}, activeToken);
            if (activeToken === token && current.status !== 'Open') showComplete(current.status);
        } catch { /* Keep the original error visible. */ }
    } finally {
        if (activeToken === token) {
            submitting = false;
            submit.disabled = false;
            submit.textContent = 'Submit registration →';
        }
    }
});

const loadInvitation = async () => {
    token = location.hash.slice(1);
    const activeToken = token;
    submitting = false;
    submit.disabled = false;
    submit.textContent = 'Submit registration →';
    form.reset();
    photo.setCustomValidity('');
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = '';
    form.hidden = true;
    error.hidden = true;
    document.getElementById('complete').hidden = true;
    document.getElementById('preview').hidden = true;
    document.getElementById('photo-placeholder').hidden = false;
    status.hidden = false;
    status.textContent = 'Checking your invitation…';
    try {
        const result = await request('status', {}, activeToken);
        if (activeToken !== token) return;
        if (result.status !== 'Open') return showComplete(result.status);
        status.hidden = true;
        form.hidden = false;
    } catch (failure) {
        if (activeToken === token) status.textContent = failure.message || 'Unable to check your invitation. Please try again.';
    }
};
window.addEventListener('hashchange', loadInvitation);
loadInvitation();
