/* Sofia's Fresh Lemonade: the small amount of script the page needs.
   Everything still reads and links fine without it. */
(() => {
  'use strict';

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const hasObserver = 'IntersectionObserver' in window;
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  const PHONE = '+17542099503';
  const INSTAGRAM_DM = 'https://ig.me/m/sofias_fresh_lemonade';

  /* ---- clips: load when near, play only while on screen ---- */

  const films = $$('video.film');
  const load = (video) => {
    if (video.dataset.src && !video.getAttribute('src')) video.src = video.dataset.src;
  };
  const play = (video) => {
    const attempt = video.play();
    if (attempt && typeof attempt.catch === 'function') attempt.catch(() => {});
  };

  if (reduceMotion) {
    // No autoplay. Give people the controls instead.
    films.forEach((video) => {
      video.removeAttribute('autoplay');
      video.pause();
      video.controls = true;
      load(video);
    });
  } else if (hasObserver) {
    const watcher = new IntersectionObserver((entries) => {
      entries.forEach(({ target, isIntersecting }) => {
        if (isIntersecting) { load(target); play(target); } else { target.pause(); }
      });
    }, { rootMargin: '160px 0px', threshold: 0.1 });
    films.forEach((video) => watcher.observe(video));
  } else {
    films.forEach((video) => { load(video); play(video); });
  }

  /* ---- things that settle into place when you reach them ---- */

  const settlers = $$('.settle, .tag-wrap');
  if (hasObserver && !reduceMotion) {
    const arrive = new IntersectionObserver((entries) => {
      entries.forEach(({ target, isIntersecting }) => {
        if (!isIntersecting) return;
        target.classList.add('is-in');
        arrive.unobserve(target);
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.15 });
    settlers.forEach((el) => arrive.observe(el));
  } else {
    settlers.forEach((el) => el.classList.add('is-in'));
  }

  /* ---- choose your flavor ---- */

  const stage = $('#cup-stage');
  if (stage) {
    const nameEl = $('#flavor-name');
    const noteEl = $('#flavor-note');
    const flavors = $$('input[name="flavor"]');
    let timers = [];

    const fill = (input) => {
      stage.style.setProperty('--liquid', input.dataset.liquid);
      stage.style.setProperty('--deep', input.dataset.deep);
      stage.style.setProperty('--straw', input.dataset.straw);
      const label = $(`label[for="${input.id}"]`);
      nameEl.textContent = label ? label.textContent.trim() : '';
      noteEl.textContent = input.dataset.note || '';
    };

    const pour = (input, { firstPour = false } = {}) => {
      timers.forEach(clearTimeout);
      timers = [];
      if (reduceMotion) { fill(input); return; }

      const drain = firstPour ? 0 : 430;
      if (!firstPour) {
        stage.classList.remove('is-pouring');
        stage.classList.add('is-draining');
        stage.style.setProperty('--level', '0.03');
      }
      timers.push(setTimeout(() => {
        fill(input);
        stage.classList.remove('is-draining', 'is-waiting');
        // restart the stream animation if someone taps quickly through flavors
        void stage.offsetWidth;
        stage.classList.add('is-pouring');
        stage.style.setProperty('--level', '1');
      }, drain));
      timers.push(setTimeout(() => stage.classList.remove('is-pouring'), drain + 1450));
    };

    flavors.forEach((input) => {
      input.addEventListener('change', () => { if (input.checked) pour(input); });
    });

    const current = () => flavors.find((input) => input.checked) || flavors[0];
    fill(current());

    // The cup starts empty and gets its first pour when you scroll to it.
    if (!reduceMotion && hasObserver) {
      stage.classList.add('is-waiting');
      stage.style.setProperty('--level', '0.03');
      const firstLook = new IntersectionObserver(([entry]) => {
        if (!entry.isIntersecting) return;
        firstLook.disconnect();
        pour(current(), { firstPour: true });
      }, { threshold: 0.4 });
      firstLook.observe(stage);
    }
  }

  /* ---- booking request: build the message, then hand it to Messages or Instagram ---- */

  const form = $('#request');
  if (form) {
    const noteText = $('#note-text');
    const textLink = $('#send-text');
    const dmButton = $('#send-dm');
    const status = $('#send-status');
    const dateInput = $('#r-date');

    if (dateInput) {
      const now = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      dateInput.min = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    }

    const readableDate = (value) => {
      const [year, month, day] = value.split('-').map(Number);
      if (!year || !month || !day) return '';
      return new Date(year, month - 1, day).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    };

    const compose = () => {
      const data = new FormData(form);
      const name = String(data.get('name') || '').trim();
      const place = String(data.get('place') || '').trim();
      const guests = String(data.get('guests') || '');
      const occasion = String(data.get('occasion') || 'our event');
      const date = readableDate(String(data.get('date') || ''));

      let message = "Hi Sofia's Fresh Lemonade! ";
      if (name) message += `This is ${name}. `;
      message += `I'd love to have your stand at ${occasion}`;
      if (date) message += ` on ${date}`;
      message += '.';
      if (place) message += ` Location: ${place}.`;
      if (guests) message += ` We're expecting ${guests}.`;
      message += date ? ' Is that date open?' : ' Are you available?';
      return message;
    };

    const refresh = () => {
      const message = compose();
      noteText.textContent = message;
      // "?&body=" is the form both iPhone and Android accept
      textLink.href = `sms:${PHONE}?&body=${encodeURIComponent(message)}`;
      status.textContent = '';
    };

    const copy = (text) => {
      let done = false;
      try {
        const scratch = document.createElement('textarea');
        scratch.value = text;
        scratch.setAttribute('readonly', '');
        scratch.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
        document.body.appendChild(scratch);
        scratch.select();
        scratch.setSelectionRange(0, text.length);
        done = document.execCommand('copy');
        scratch.remove();
      } catch (error) { done = false; }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => { done = true; }, () => {});
      }
      return done;
    };

    form.addEventListener('input', refresh);
    form.addEventListener('change', refresh);
    form.addEventListener('submit', (event) => event.preventDefault());
    refresh();

    dmButton.addEventListener('click', () => {
      const copied = copy(compose());
      status.textContent = copied
        ? 'Message copied. Paste it into our Instagram chat.'
        : 'Instagram is opening. Copy the message above and paste it in.';
      window.open(INSTAGRAM_DM, '_blank', 'noopener');
    });
  }

  /* ---- the floating "Book the stand" button ---- */

  const pill = $('#book-pill');
  const heroActions = $('.hero .actions');
  const bookSection = $('#book');
  const footer = $('.foot');
  if (pill && heroActions && bookSection && hasObserver) {
    let pastHero = false;
    const ending = new Set();
    const sync = () => pill.classList.toggle('is-on', pastHero && ending.size === 0);

    new IntersectionObserver(([entry]) => {
      pastHero = !entry.isIntersecting && entry.boundingClientRect.top < 0;
      sync();
    }).observe(heroActions);

    const endWatcher = new IntersectionObserver((entries) => {
      entries.forEach(({ target, isIntersecting }) => {
        if (isIntersecting) ending.add(target); else ending.delete(target);
      });
      sync();
    }, { threshold: 0.02 });
    endWatcher.observe(bookSection);
    if (footer) endWatcher.observe(footer);
  }
})();
