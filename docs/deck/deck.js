// Slide navigation: one slide visible at a time, moved by left/right/home/end
// or the buttons. Up/down/page keys stay native so tall slides can be scrolled.
// A slide change scrolls to the top and focuses the shown slide's heading, so
// a keyboard or screen-reader user lands on the new content.
(function () {
  document.documentElement.lang = 'en';
  var slides = Array.prototype.slice.call(document.querySelectorAll('main > section'));
  var counter = document.getElementById('counter');
  var prev = document.getElementById('prev');
  var next = document.getElementById('next');
  var current = 0;

  function show(index, moveFocus) {
    current = Math.max(0, Math.min(slides.length - 1, index));
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
    if (event.key === 'Home') show(0, true);
    else if (event.key === 'End') show(slides.length - 1, true);
    else if (KEYS[event.key]) show(current + KEYS[event.key], true);
    else return;
    event.preventDefault();
  });
  prev.addEventListener('click', function () { show(current - 1, true); });
  next.addEventListener('click', function () { show(current + 1, true); });
  show(0, false);
})();
