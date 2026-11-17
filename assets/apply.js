(function () {
  var f = document.getElementById('applyForm');
  if (!f) return;
  var done = document.getElementById('applyDone');
  var msg = f.querySelector('.form-msg');
  var btn = f.querySelector('button[type=submit]');
  var FALLBACK = ' You can also email king@floodinternational.com.';
  var q = new URLSearchParams(location.search);

  var pre = q.get('plan');
  if (pre) f.querySelectorAll('input[name=plan]').forEach(function (r) { if (r.value === pre) r.checked = true; });
  btn.disabled = false;   // enabled only once this handler exists

  f.addEventListener('submit', function (e) {
    e.preventDefault();
    var fd = new FormData(f);
    var d = Object.fromEntries(fd.entries());
    d.slipping = fd.getAll('slipping');
    var miss = [];
    if (!d.name) miss.push('name');
    if (!d.email) miss.push('email');
    if (!d.phone) miss.push('phone');
    if (!d.company) miss.push('business name');
    if (!d.industry) miss.push('industry');
    if (!d.locations) miss.push('locations');
    if (!d.plan) miss.push('plan');
    if (!d.budget) miss.push('budget');
    if (miss.length) { msg.textContent = 'Please fill in: ' + miss.join(', ') + '.'; return; }
    if (d.phone.replace(/\D/g, '').length < 10) { msg.textContent = 'Please enter a 10-digit phone number.'; return; }
    if (!f.submission_id.value) f.submission_id.value = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2);
    d.submission_id = f.submission_id.value;
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content'].forEach(function (k) { if (q.get(k)) d[k] = q.get(k); });
    d.referrer = document.referrer;
    btn.disabled = true; msg.textContent = 'Sending...';
    fetch('/api/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (x) {
        if (x.j && x.j.pending) { msg.textContent = x.j.message; }   // uncertain: keep the button disabled so it isn't sent twice
        else if (x.ok) { f.reset(); f.hidden = true; done.hidden = false; done.focus(); done.scrollIntoView({ block: 'start' }); }
        else {
          var err = (x.j && x.j.error) || 'Something went wrong.';
          msg.textContent = err + (/king@floodinternational\.com/.test(err) ? '' : FALLBACK);
          btn.disabled = false;
        }
      })
      .catch(function () { msg.textContent = 'We could not reach our server.' + FALLBACK; btn.disabled = false; });
  });
})();
