// Slide navigation: one slide visible at a time, moved by left/right/home/end
// or the buttons. Up/down/page keys stay native so tall slides can be scrolled.
// A slide change scrolls to the top and focuses the shown slide's heading, so
// a keyboard or screen-reader user lands on the new content.
// The #lang button toggles English and Korean: every [lang] element in the body
// is shown or hidden, and image alt text and aria-labels are swapped from their
// data-alt-* / data-label-* attributes. The current slide does not change.
(function () {
  function setLanguage(code) {
    document.documentElement.lang = code;
    var toggle = document.getElementById('lang');
    Array.prototype.forEach.call(document.body.querySelectorAll('[lang]'), function (el) {
      // The toggle names the other language, so its labels follow the inverse rule.
      el.hidden = toggle.contains(el) ? el.lang === code : el.lang !== code;
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-alt-en]'), function (el) {
      el.alt = el.getAttribute('data-alt-' + code);
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-label-en]'), function (el) {
      el.setAttribute('aria-label', el.getAttribute('data-label-' + code));
    });
  }
  setLanguage('en');
  var slides = Array.prototype.slice.call(document.querySelectorAll('main > section'));
  var counter = document.getElementById('counter');
  var prev = document.getElementById('prev');
  var next = document.getElementById('next');
  var current = 0;

  function show(index, moveFocus) {
    var target = Math.max(0, Math.min(slides.length - 1, index));
    if (moveFocus && target === current) return;
    current = target;
    slides.forEach(function (slide, i) { slide.hidden = i !== current; });
    counter.textContent = current + 1 + ' / ' + slides.length;
    prev.disabled = current === 0;
    next.disabled = current === slides.length - 1;
    if (moveFocus) {
      window.scrollTo(0, 0);
      slides[current].querySelector('h1, h2').focus({ preventScroll: true });
    }
  }

  var KEYS = { ArrowRight: 1, ArrowLeft: -1 };
  document.addEventListener('keydown', function (event) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.target && event.target.closest && event.target.closest('.positioning')) return;
    if (event.key === 'Home') show(0, true);
    else if (event.key === 'End') show(slides.length - 1, true);
    else if (KEYS[event.key]) show(current + KEYS[event.key], true);
    else return;
    event.preventDefault();
  });
  prev.addEventListener('click', function () { show(current - 1, true); });
  next.addEventListener('click', function () { show(current + 1, true); });
  document.getElementById('lang').addEventListener('click', function () {
    setLanguage(document.documentElement.lang === 'en' ? 'ko' : 'en');
  });
  show(0, false);
})();
