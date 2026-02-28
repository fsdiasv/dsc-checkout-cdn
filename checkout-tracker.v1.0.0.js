(function () {
  'use strict';

  var VERSION = '1.0.0';
  var IDENTIFY_IDLE_MS = 2000;
  var STORAGE = {
    sessionId: 'dsc_checkout_session_id',
    firstTouch: 'dsc_first_touch',
    lastTouch: 'dsc_last_touch',
    identifiedMap: 'dsc_identified_map'
  };

  var DEFAULT_SELECTORS = {
    emailInput: 'input[name="email"]',
    nameInput: 'input[name="first_name"]',
    productName: 'div[data-test-id^="offer-price-"] label div',
    orderBumpCheckbox: '[id^="order-bump-"] input[type="checkbox"]',
    paymentMethodRadios: '[id^="payment-method-"] input[type="radio"]',
    paymentButtons: 'button[id^="payment-button-"]'
  };

  var config = window.DSC_CHECKOUT_CONFIG || {};
  var endpoint = config.endpoint || '';
  var siteId = config.siteId || 'systeme-default';
  var selectors = Object.assign({}, DEFAULT_SELECTORS, config.selectors || {});
  var debug = Boolean(config.debug);

  if (!endpoint) {
    return;
  }

  var boundElements = new WeakSet();
  var identifyTimer = null;
  var observer = null;

  function log() {
    if (!debug || !console || !console.log) {
      return;
    }
    console.log.apply(console, ['[DSC Tracker]'].concat(Array.prototype.slice.call(arguments)));
  }

  function tryParseJSON(raw, fallback) {
    try {
      return JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  }

  function safeLocalStorageGet(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }

  function safeLocalStorageSet(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (e) {
      // ignore storage errors
    }
  }

  function safeSessionStorageGet(key) {
    try {
      return window.sessionStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }

  function safeSessionStorageSet(key, value) {
    try {
      window.sessionStorage.setItem(key, value);
    } catch (e) {
      // ignore storage errors
    }
  }

  function generateUUID() {
    if (window.crypto && window.crypto.randomUUID) {
      return window.crypto.randomUUID();
    }

    var ts = Date.now();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (ts + Math.random() * 16) % 16 | 0;
      ts = Math.floor(ts / 16);
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  function getSessionId() {
    var existing = safeSessionStorageGet(STORAGE.sessionId);
    if (existing) {
      return existing;
    }
    var created = generateUUID();
    safeSessionStorageSet(STORAGE.sessionId, created);
    return created;
  }

  function currentIso() {
    return new Date().toISOString();
  }

  function getDeviceType() {
    var ua = navigator.userAgent || '';
    if (/(tablet|ipad|playbook|silk)|(android(?!.*mobi))/i.test(ua)) {
      return 'tablet';
    }
    if (/Mobile|Android|iP(hone|od)|IEMobile|BlackBerry|Kindle|Silk-Accelerated|(hpw|web)OS|Opera M(obi|ini)/.test(ua)) {
      return 'mobile';
    }
    return 'desktop';
  }

  function getCleanUrl() {
    try {
      var url = new URL(window.location.href);
      return url.origin + url.pathname;
    } catch (e) {
      return window.location.href.split('?')[0].split('#')[0];
    }
  }

  function getUrlParamsObject() {
    var params = new URLSearchParams(window.location.search);
    var all = {};
    params.forEach(function (value, key) {
      all[key] = value;
    });
    return all;
  }

  function getTouchObject() {
    return {
      captured_at: currentIso(),
      page_url: getCleanUrl(),
      params: getUrlParamsObject()
    };
  }

  function initTouchAttribution() {
    var firstTouch = safeLocalStorageGet(STORAGE.firstTouch);
    if (!firstTouch) {
      safeLocalStorageSet(STORAGE.firstTouch, JSON.stringify(getTouchObject()));
    }
    safeLocalStorageSet(STORAGE.lastTouch, JSON.stringify(getTouchObject()));
  }

  function getAttribution() {
    var params = new URLSearchParams(window.location.search);
    var allParams = getUrlParamsObject();

    return {
      utm_source: params.get('utm_source') || '',
      utm_medium: params.get('utm_medium') || '',
      utm_campaign: params.get('utm_campaign') || '',
      utm_term: params.get('utm_term') || '',
      utm_content: params.get('utm_content') || '',
      subid: params.get('k_subid') || params.get('subid') || params.get('_subid') || '',
      external_id: params.get('external_id') || '',
      all_params: allParams,
      first_touch: tryParseJSON(safeLocalStorageGet(STORAGE.firstTouch) || '{}', {}),
      last_touch: tryParseJSON(safeLocalStorageGet(STORAGE.lastTouch) || '{}', {})
    };
  }

  function getValue(selector) {
    var node = document.querySelector(selector);
    if (!node) {
      return '';
    }
    return (node.value || node.textContent || '').trim();
  }

  function getEmail() {
    return getValue(selectors.emailInput).toLowerCase();
  }

  function getName() {
    return getValue(selectors.nameInput);
  }

  function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '');
  }

  function getUrlSlug() {
    var parts = (window.location.pathname || '').split('/').filter(Boolean);
    return parts.length ? parts[parts.length - 1] : '';
  }

  function getActivePlanContainer() {
    var selected = document.querySelector('input[type="radio"]:checked');
    if (!selected) {
      return null;
    }
    return selected.closest('[class*="PricePlanItemUi"]') || selected.closest('section') || null;
  }

  function extractPriceData() {
    var fallback = {
      product_slug: getUrlSlug(),
      product_name: getValue(selectors.productName) || 'Produto não encontrado',
      price: 0,
      currency: ''
    };

    var container = getActivePlanContainer();
    if (!container) {
      return fallback;
    }

    var nameNode = container.querySelector('label div');
    var priceNode = container.querySelector('[class*="PricePlanAmountUi"]');
    var currencyNode = priceNode ? priceNode.querySelector('[class*="CurrencyBadgeUi"]') : null;

    var productName = nameNode ? nameNode.textContent.trim() : fallback.product_name;
    var currency = currencyNode ? currencyNode.textContent.trim().toUpperCase() : '';

    var price = 0;
    if (priceNode) {
      var priceText = priceNode.textContent.trim();
      if (currencyNode) {
        priceText = priceText.replace(currencyNode.textContent, '').trim();
      }
      var normalized = priceText.replace(/[^\d,.-]/g, '').replace(/\.(?=.*\.)/g, '').replace(',', '.');
      var parsed = parseFloat(normalized);
      if (!isNaN(parsed)) {
        price = parsed;
      }
    }

    return {
      product_slug: getUrlSlug(),
      product_name: productName,
      price: price,
      currency: currency
    };
  }

  function getContext(extra) {
    return Object.assign(
      {
        page_url: getCleanUrl(),
        referrer: document.referrer || 'direct',
        user_agent: navigator.userAgent || '',
        language: navigator.language || '',
        device_type: getDeviceType()
      },
      extra || {}
    );
  }

  function buildPayload(eventName, contextExtra) {
    return {
      event_id: generateUUID(),
      event_name: eventName,
      occurred_at: currentIso(),
      session_id: getSessionId(),
      site_id: siteId,
      contact: {
        email: getEmail(),
        name: getName()
      },
      checkout: extractPriceData(),
      attribution: getAttribution(),
      context: getContext(contextExtra),
      schema_version: '1',
      script_version: VERSION
    };
  }

  function sendEvent(payload) {
    var body = JSON.stringify(payload);
    var beaconSent = false;

    if (navigator.sendBeacon) {
      try {
        beaconSent = navigator.sendBeacon(endpoint, new Blob([body], { type: 'application/json' }));
      } catch (e) {
        beaconSent = false;
      }
    }

    if (!beaconSent) {
      fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-DSC-Site': siteId
        },
        body: body,
        keepalive: true,
        mode: 'cors',
        credentials: 'omit'
      }).catch(function (error) {
        log('Erro ao enviar evento', payload.event_name, error);
      });
    }

    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push({
      event: payload.event_name,
      dsc_session_id: payload.session_id,
      dsc_product_slug: payload.checkout.product_slug,
      dsc_site_id: siteId
    });

    log('Evento enviado', payload.event_name, payload);
  }

  function identifiedStorageMap() {
    return tryParseJSON(safeSessionStorageGet(STORAGE.identifiedMap) || '{}', {});
  }

  function markIdentified(email) {
    var map = identifiedStorageMap();
    map[getSessionId() + '::' + email] = currentIso();
    safeSessionStorageSet(STORAGE.identifiedMap, JSON.stringify(map));
  }

  function alreadyIdentified(email) {
    var map = identifiedStorageMap();
    return Boolean(map[getSessionId() + '::' + email]);
  }

  function fireCheckoutIdentified(reason) {
    var email = getEmail();
    if (!isValidEmail(email)) {
      return;
    }

    if (alreadyIdentified(email)) {
      return;
    }

    var payload = buildPayload('checkout_identified', { identify_reason: reason || 'unknown' });
    sendEvent(payload);
    markIdentified(email);
  }

  function getSelectedPaymentMethod() {
    var selected = document.querySelector(selectors.paymentMethodRadios + ':checked');
    if (!selected) {
      return 'unknown';
    }

    var container = selected.closest('[data-test-id]');
    if (container && container.dataset && container.dataset.testId) {
      return container.dataset.testId.replace('payment-method-', '');
    }

    var siblingText = selected.nextElementSibling && selected.nextElementSibling.textContent;
    if (siblingText) {
      return siblingText.trim();
    }

    return selected.value || 'unknown';
  }

  function handlePaymentMethodChange() {
    var payload = buildPayload('checkout_payment_method_selected', {
      selected_payment_method: getSelectedPaymentMethod()
    });
    sendEvent(payload);
  }

  function handleOrderBumpToggle(event) {
    var payload = buildPayload('checkout_order_bump_toggled', {
      order_bump_checked: Boolean(event && event.target && event.target.checked)
    });
    sendEvent(payload);
  }

  function handlePaymentAttempt(event) {
    var email = getEmail();
    var name = getName();
    var fieldsValid = Boolean(isValidEmail(email) && name);

    var button = event && event.target ? event.target.closest('button') : null;
    var payload = buildPayload('checkout_payment_attempted', {
      selected_payment_method: getSelectedPaymentMethod(),
      button_id: button ? button.id || '' : '',
      fields_valid: fieldsValid
    });
    sendEvent(payload);
  }

  function bindElement(element, eventName, handler) {
    if (!element || boundElements.has(element)) {
      return;
    }
    element.addEventListener(eventName, handler);
    boundElements.add(element);
  }

  function setupListeners() {
    var emailInput = document.querySelector(selectors.emailInput);
    if (emailInput && !boundElements.has(emailInput)) {
      bindElement(emailInput, 'blur', function () {
        fireCheckoutIdentified('blur');
      });
      bindElement(emailInput, 'input', function () {
        clearTimeout(identifyTimer);
        identifyTimer = setTimeout(function () {
          fireCheckoutIdentified('idle');
        }, IDENTIFY_IDLE_MS);
      });
    }

    var orderBump = document.querySelector(selectors.orderBumpCheckbox);
    bindElement(orderBump, 'change', handleOrderBumpToggle);

    document.querySelectorAll(selectors.paymentMethodRadios).forEach(function (radio) {
      bindElement(radio, 'change', handlePaymentMethodChange);
    });

    document.querySelectorAll(selectors.paymentButtons).forEach(function (button) {
      bindElement(button, 'click', handlePaymentAttempt);
    });
  }

  function setupObserver() {
    if (!document.body) {
      return;
    }

    var pending = false;
    observer = new MutationObserver(function () {
      if (pending) {
        return;
      }
      pending = true;
      setTimeout(function () {
        pending = false;
        setupListeners();
      }, 100);
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  function initialize() {
    initTouchAttribution();
    setupListeners();
    setupObserver();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize);
  } else {
    initialize();
  }
})();
