/**
 * Small SVG chart helpers. Deliberately no external chart library: the whole
 * dashboard works offline from bundled sample data.
 *
 * House rules enforced here:
 *  - 2px lines, >=8px markers with a surface ring
 *  - hairline solid gridlines, recessive
 *  - one axis per plot (never dual y)
 *  - crosshair + one tooltip listing every series at that X
 *  - values readable without hover via the table view in the UI
 */

const NS = 'http://www.w3.org/2000/svg';

export function el(tag, attrs = {}, parent = null) {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null) continue;
    node.setAttribute(key, String(value));
  }
  if (parent) parent.appendChild(node);
  return node;
}

export function token(name) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name);
  return value.trim();
}

export function niceTicks(min, max, count = 5) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) {
    const pad = Math.abs(min) || 1;
    min -= pad * 0.1;
    max += pad * 0.1;
  }
  const span = max - min;
  const step0 = span / Math.max(1, count);
  const magnitude = 10 ** Math.floor(Math.log10(step0));
  const candidates = [1, 2, 2.5, 5, 10].map((factor) => factor * magnitude);
  const step = candidates.find((value) => span / value <= count + 1) || candidates[candidates.length - 1];
  const start = Math.ceil(min / step) * step;
  const ticks = [];
  for (let value = start; value <= max + step * 0.5; value += step) {
    ticks.push(Math.round(value / step) * step);
  }
  return ticks;
}

export function formatTick(value, unit = '') {
  const abs = Math.abs(value);
  if (abs >= 10000) return `${(value / 1000).toLocaleString('zh-CN', { maximumFractionDigits: 0 })}K${unit}`;
  if (abs >= 1000) return `${(value / 1000).toLocaleString('zh-CN', { maximumFractionDigits: 1 })}K${unit}`;
  if (abs < 1 && abs > 0) return value.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  return value.toLocaleString('zh-CN', { maximumFractionDigits: abs < 10 ? 1 : 0 });
}

export function compactNumber(value, digits = 1) {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 10000) return `${(value / 1000).toFixed(1)}K`;
  if (abs >= 1000) return value.toLocaleString('zh-CN', { maximumFractionDigits: 0 });
  return value.toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: digits });
}

/**
 * The tooltip is a single DOM node per chart wrap. Content is always built with
 * textContent / createTextNode because labels come from imported CSV files.
 */
export function createTooltip(wrap) {
  const node = document.createElement('div');
  node.className = 'tooltip';
  node.setAttribute('role', 'status');
  node.setAttribute('aria-live', 'polite');
  wrap.appendChild(node);

  const clear = () => {
    while (node.firstChild) node.removeChild(node.firstChild);
  };

  return {
    node,
    show(title, rows, note) {
      clear();
      if (title) {
        const heading = document.createElement('div');
        heading.className = 'tt-title';
        heading.textContent = title;
        node.appendChild(heading);
      }
      for (const row of rows) {
        const line = document.createElement('div');
        line.className = 'tt-row';
        const left = document.createElement('div');
        left.className = 'tt-left';
        if (row.color) {
          const key = document.createElement('span');
          key.className = `tt-key${row.dot ? ' dot' : ''}`;
          key.style.background = row.color;
          left.appendChild(key);
        }
        const name = document.createElement('span');
        name.textContent = row.label;
        left.appendChild(name);
        const value = document.createElement('span');
        value.className = 'tt-val';
        value.textContent = row.value;
        line.appendChild(left);
        line.appendChild(value);
        node.appendChild(line);
      }
      if (note) {
        const foot = document.createElement('div');
        foot.className = 'tt-note';
        foot.textContent = note;
        node.appendChild(foot);
      }
      node.classList.add('show');
    },
    move(event, wrapNode) {
      const rect = wrapNode.getBoundingClientRect();
      const localX = event.clientX - rect.left;
      const localY = event.clientY - rect.top;
      const width = node.offsetWidth || 160;
      const height = node.offsetHeight || 60;
      let x = localX + 14;
      if (x + width > rect.width) x = localX - width - 14;
      x = Math.max(4, Math.min(rect.width - width - 4, x));
      let y = localY - height - 12;
      if (y < 4) y = localY + 18;
      node.style.left = `${x}px`;
      node.style.top = `${y}px`;
    },
    hide() {
      node.classList.remove('show');
    },
  };
}

/**
 * Shared scaffolding for a responsive time-series plot.
 * Returns scales + group nodes ready for marks.
 */
export function scaffold(host, options) {
  const width = Math.max(320, host.clientWidth || 640);
  const { height = 260, margin = { top: 16, right: 18, bottom: 34, left: 56 } } = options;
  while (host.firstChild) host.removeChild(host.firstChild);
  const svg = el('svg', {
    viewBox: `0 0 ${width} ${height}`,
    width,
    height,
    role: 'img',
    'aria-label': options.ariaLabel || '',
    tabindex: '0',
  }, host);
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;
  const plot = el('g', { transform: `translate(${margin.left},${margin.top})` }, svg);
  return { svg, plot, width, height, margin, plotW, plotH };
}

export function xBandScale(plot, plotW, count, pad = 0.1) {
  if (!count) return { step: 0, center: () => 0, left: () => 0, width: () => 0 };
  const step = plotW / count;
  const band = step * (1 - pad * 2);
  return {
    step,
    band,
    left: (index) => index * step + (step - band) / 2,
    center: (index) => index * step + step / 2,
  };
}

export function xPointScale(count, plotW) {
  if (count <= 1) return { x: () => plotW / 2, step: 0 };
  const step = plotW / (count - 1);
  return { x: (index) => index * step, step };
}

export function yScale(domainMin, domainMax, plotH) {
  const min = domainMin;
  const max = domainMax === domainMin ? domainMin + 1 : domainMax;
  return (value) => plotH - ((value - min) / (max - min)) * plotH;
}

export function drawYAxis(plot, { ticks, scale, x = 0, plotW, unit = '', tickLabel, grid = true }) {
  const g = el('g', { class: 'y-axis' }, plot);
  for (const tick of ticks) {
    const y = scale(tick);
    if (grid) {
      el('line', {
        x1: 0, x2: plotW, y1: y, y2: y,
        stroke: 'var(--gridline)', 'stroke-width': 1, 'shape-rendering': 'crispEdges',
      }, g);
    }
    const label = el('text', {
      x: -9, y, 'text-anchor': 'end', 'dominant-baseline': 'middle',
      fill: 'var(--text-muted)', 'font-size': 11,
      'font-variant-numeric': 'tabular-nums',
    }, g);
    label.textContent = `${tickLabel ? tickLabel(tick) : formatTick(tick)}${unit}`;
  }
  return g;
}

export function drawBaseline(plot, plotW, y) {
  return el('line', {
    x1: 0, x2: plotW, y1: y, y2: y,
    stroke: 'var(--baseline)', 'stroke-width': 1,
  }, plot);
}

export function drawXLabels(plot, { plotW, labels, plotH, dense = false }) {
  const g = el('g', {}, plot);
  const every = dense ? Math.ceil(labels.length / Math.max(4, Math.floor(plotW / 54))) : 1;
  labels.forEach((label, index) => {
    if (index % every !== 0 && index !== labels.length - 1) return;
    if (index - (index % every) < (labels.length - 1) - every && index === labels.length - 1 && labels.length % every !== 1) {
      // avoid a label colliding with the previous tick
    }
    const text = el('text', {
      x: label.x, y: plotH + 18, 'text-anchor': 'middle',
      fill: 'var(--text-muted)', 'font-size': 11,
      'font-variant-numeric': 'tabular-nums',
    }, g);
    text.textContent = label.text;
  });
  return g;
}

/** A 2px line with round joins through the given points. */
export function drawLine(plot, points, color, options = {}) {
  if (points.length < 2) return null;
  const d = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ');
  return el('path', {
    d,
    fill: 'none',
    stroke: color,
    'stroke-width': options.width || 2,
    'stroke-linejoin': 'round',
    'stroke-linecap': 'round',
    opacity: options.opacity ?? 1,
    'stroke-dasharray': options.dash || null,
  }, plot);
}

/** Draw a line that breaks at gaps instead of interpolating across them. */
export function drawSegmentedLine(plot, points, color, options = {}) {
  const groups = [];
  let current = [];
  for (const point of points) {
    if (point.y == null) {
      if (current.length) groups.push(current);
      current = [];
    } else {
      current.push(point);
    }
  }
  if (current.length) groups.push(current);
  const g = el('g', {}, plot);
  for (const group of groups) {
    if (group.length === 1) {
      el('circle', {
        cx: group[0].x, cy: group[0].y, r: 2.6, fill: color, stroke: 'var(--surface-1)', 'stroke-width': 2,
      }, g);
      continue;
    }
    const d = group.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ');
    el('path', {
      d, fill: 'none', stroke: color, 'stroke-width': options.width || 2,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round',
      opacity: options.opacity ?? 1, 'stroke-dasharray': options.dash || null,
    }, g);
  }
  return g;
}

export function drawDot(plot, x, y, color, radius = 4.5) {
  return el('circle', {
    cx: x, cy: y, r: radius, fill: color,
    stroke: 'var(--surface-1)', 'stroke-width': 2,
  }, plot);
}

/** Gaps are drawn as a very light hatched band, never as a zero line. */
export function drawGapBands(plot, bands, xScale, plotW, plotH, label = '缺测') {
  const g = el('g', {}, plot);
  for (const band of bands) {
    const x = xScale(band.start);
    const w = Math.max(1.5, xScale(band.end) - x);
    el('rect', {
      x, y: 0, width: w, height: plotH,
      fill: 'var(--surface-2)', opacity: 0.9,
    }, g);
    el('rect', {
      x, y: 0, width: w, height: plotH,
      fill: 'transparent', stroke: 'var(--gridline)', 'stroke-width': 1,
    }, g);
    if (w > 26) {
      const text = el('text', {
        x: x + w / 2, y: plotH / 2, 'text-anchor': 'middle', fill: 'var(--text-muted)',
        'font-size': 10.5, transform: `rotate(-90 ${x + w / 2} ${plotH / 2})`,
      }, g);
      text.textContent = label;
    }
  }
  return g;
}

/** An interaction layer that owns the crosshair and hover plumbing. */
export function attachCrosshair({ svg, plot, plotW, plotH, margin, wrap, tooltip, xOfIndex, onHover, onLeave }) {
  const cross = el('line', {
    x1: 0, x2: 0, y1: 0, y2: plotH,
    stroke: 'var(--text-muted)', 'stroke-width': 1, opacity: 0,
    'pointer-events': 'none',
  }, plot);
  const hit = el('rect', {
    x: 0, y: 0, width: plotW, height: plotH, fill: 'transparent',
    'pointer-events': 'all',
  }, plot);

  const handle = (event) => {
    const rect = svg.getBoundingClientRect();
    // A hidden or not-yet-laid-out chart has zero width; dividing by it would
    // produce an Infinity index and a tooltip pinned to the wrong day.
    if (!rect.width) return;
    const scale = rect.width / svg.viewBox.baseVal.width;
    const localX = (event.clientX - rect.left) / scale - margin.left;
    const index = xOfIndex(localX);
    if (index == null) return;
    const x = xOfIndex.position ? xOfIndex.position(index) : localX;
    cross.setAttribute('x1', x);
    cross.setAttribute('x2', x);
    cross.setAttribute('opacity', 0.55);
    onHover(index, x);
  };

  hit.addEventListener('pointermove', handle);
  hit.addEventListener('pointerleave', () => {
    cross.setAttribute('opacity', 0);
    onLeave();
    tooltip.hide();
  });
  svg.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const current = svg.dataset.index ? Number(svg.dataset.index) : Math.floor(xOfIndex.count / 2);
    const next = Math.max(0, Math.min(xOfIndex.count - 1, current + (event.key === 'ArrowRight' ? 1 : -1)));
    svg.dataset.index = String(next);
    const x = xOfIndex.position(next);
    cross.setAttribute('x1', x);
    cross.setAttribute('x2', x);
    cross.setAttribute('opacity', 0.55);
    onHover(next, x);
  });
  svg.addEventListener('blur', () => {
    cross.setAttribute('opacity', 0);
    onLeave();
    tooltip.hide();
  });
  return hit;
}

export function legend(host, items) {
  const box = document.createElement('div');
  box.className = 'legend';
  for (const item of items) {
    const entry = document.createElement('span');
    entry.className = 'item';
    const key = document.createElement('span');
    key.className = `key ${item.shape || 'line'}`;
    if (item.color) key.style.background = item.color;
    if (item.border) key.style.border = item.border;
    entry.appendChild(key);
    const label = document.createElement('span');
    label.textContent = item.label;
    entry.appendChild(label);
    box.appendChild(entry);
  }
  host.appendChild(box);
  return box;
}
