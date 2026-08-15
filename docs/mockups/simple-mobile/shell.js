/** Shared nav chrome for mockup pages */
(function () {
  const path = location.pathname.split('/').pop() || 'index.html';
  const groups = [
    {
      label: 'Translator',
      items: [
        ['t1-home.html', '1 · Choose work'],
        ['t4-scripture.html', '2 · Scripture'],
        ['t2-note.html', '3 · Note'],
        ['t3-article.html', '4 · Q / term / article'],
      ],
    },
    {
      label: 'Admin',
      items: [
        ['a1-workflow.html', '1 · Workflow'],
        ['a2-people.html', '2 · People'],
        ['a3-sections.html', '3 · Sections'],
      ],
    },
  ];

  function mountSide(el) {
    el.innerHTML = `
      <div class="brand">Bible Editor</div>
      <div class="sub">Mobile-first translator + admin concepts. Fake Spanish package for Zacarías.</div>
      <a class="ghost-btn" href="index.html" style="padding:0;margin-bottom:12px;display:inline-block">← All mockups</a>
      ${groups.map(g => `
        <div class="nav-label">${g.label}</div>
        <nav class="nav-list">
          ${g.items.map(([href, label]) =>
            `<a href="${href}" class="${href === path ? 'active' : ''}">${label}</a>`
          ).join('')}
        </nav>
      `).join('')}
    `;
  }

  document.querySelectorAll('[data-side]').forEach(mountSide);

  window.showToast = function (phoneEl, msg) {
    let t = phoneEl.querySelector('.toast');
    if (!t) {
      t = document.createElement('div');
      t.className = 'toast';
      phoneEl.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._hide);
    t._hide = setTimeout(() => t.classList.remove('show'), 1800);
  };
})();
