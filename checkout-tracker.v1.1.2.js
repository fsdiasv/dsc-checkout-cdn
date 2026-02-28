(function () {
  'use strict';

  var VERSION = '1.1.2';
  var IDENTIFY_IDLE_MS = 2000;
  var STORAGE = {
    sessionId: 'dsc_checkout_session_id',
    firstTouch: 'dsc_first_touch',
    lastTouch: 'dsc_last_touch',
    identifiedMap: 'dsc_identified_map',
    checkoutEmail: 'dsc_checkout_email',
    checkoutName: 'dsc_checkout_name'
  };

  var DEFAULT_SELECTORS = {
    emailInput: 'input[name="email"]',
    nameInput: 'input[name="first_name"]',
    productName: 'div[data-test-id^="offer-price-"] label div',
    offerNode: '[data-test-id^="offer-price-"]',
    orderBumpCheckbox: '[id^="order-bump-"] input[type="checkbox"]',
    paymentMethodRadios: '[id^="payment-method-"] input[type="radio"]',
    paymentButtons: 'button[id^="payment-button-"], button[id^="paymentbutton-"]'
  };

  var config = window.DSC_CHECKOUT_CONFIG || {};
  var endpoint = config.endpoint || '';
  var siteId = config.siteId || 'systeme-default';
  var selectors = Object.assign({}, DEFAULT_SELECTORS, config.selectors || {});
  var debug = Boolean(config.debug);
  var enableLegacyDataLayerCompat = config.enableLegacyDataLayerCompat !== false;
  var enableUrlParamPropagation = config.enableUrlParamPropagation !== false;
  var enablePrefillFromStorage = config.enablePrefillFromStorage !== false;

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

  function normalizeString(value) {
    if (typeof value !== 'string') {
      return '';
    }
    return value.trim();
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

  function hasAnyUrlParams() {
    return new URLSearchParams(window.location.search).toString() !== '';
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

  function splitName(fullName) {
    var normalized = normalizeString(fullName);
    if (!normalized) {
      return { firstName: '', lastName: '' };
    }
    var parts = normalized.split(/\s+/);
    return {
      firstName: parts[0] || '',
      lastName: parts.length > 1 ? parts.slice(1).join(' ') : ''
    };
  }

  function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '');
  }

  function getUrlSlug() {
    var parts = (window.location.pathname || '').split('/').filter(Boolean);
    return parts.length ? parts[parts.length - 1] : '';
  }

  function getPageLanguage() {
    return normalizeString(config.checkoutLanguage) || normalizeString(document.documentElement.lang);
  }

  function getBrowserLanguage() {
    return normalizeString(navigator.language || '');
  }

  function getBrowserLanguages() {
    if (!Array.isArray(navigator.languages)) {
      return [];
    }
    return navigator.languages
      .map(function (item) {
        return normalizeString(item);
      })
      .filter(Boolean);
  }

  function getPrimaryLanguage() {
    return getPageLanguage() || getBrowserLanguage();
  }

  function getTimezone() {
    try {
      var tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      return normalizeString(tz);
    } catch (e) {
      return '';
    }
  }

  function extractOfferIdFromTestId(testId) {
    var clean = normalizeString(testId);
    var match = clean.match(/^offer-price-(.+)$/i);
    return match ? match[1] : '';
  }

  function getConfiguredProductData() {
    return {
      product_id: normalizeString(config.productId),
      product_slug: normalizeString(config.productSlug),
      product_name: normalizeString(config.productName),
      offer_id: normalizeString(config.offerId),
      currency: normalizeString(config.currency).toUpperCase()
    };
  }

  function getOfferNode() {
    return document.querySelector(selectors.offerNode);
  }

  function getActivePlanContainer() {
    var selected = document.querySelector('input[type="radio"]:checked');
    if (!selected) {
      return null;
    }

    var offer = selected.closest('[data-test-id^="offer-price-"]');
    if (offer) {
      return offer;
    }

    return selected.closest('[class*="PricePlanItemUi"]') || selected.closest('section') || null;
  }

  function parsePrice(container) {
    var priceNode = container ? container.querySelector('[class*="PricePlanAmountUi"]') : null;
    if (!priceNode) {
      return { price: 0, currency: '' };
    }

    var currencyNode = priceNode.querySelector('[class*="CurrencyBadgeUi"]');
    var currency = currencyNode ? normalizeString(currencyNode.textContent).toUpperCase() : '';

    var priceText = normalizeString(priceNode.textContent);
    if (currencyNode) {
      priceText = normalizeString(priceText.replace(currencyNode.textContent, ''));
    }

    var normalized = priceText.replace(/[^\d,.-]/g, '').replace(/\.(?=.*\.)/g, '').replace(',', '.');
    var parsed = parseFloat(normalized);

    return {
      price: isNaN(parsed) ? 0 : parsed,
      currency: currency
    };
  }

  function extractCheckoutData() {
    var configured = getConfiguredProductData();

    var offerNode = getOfferNode();
    var offerTestId = offerNode ? normalizeString(offerNode.getAttribute('data-test-id') || '') : '';
    var fallbackOfferId = extractOfferIdFromTestId(offerTestId);

    var fallbackName =
      getValue(selectors.productName) ||
      (offerNode ? normalizeString(offerNode.textContent) : '') ||
      'Produto não encontrado';

    var activeContainer = getActivePlanContainer();
    var parsedPrice = parsePrice(activeContainer || offerNode);

    var productSlug = configured.product_slug || getUrlSlug();
    var productName = configured.product_name || fallbackName;
    var offerId = configured.offer_id || fallbackOfferId;
    var currency = configured.currency || parsedPrice.currency;
    var productId = configured.product_id || productSlug;

    if (configured.product_name && fallbackName && configured.product_name !== fallbackName) {
      log('Divergencia product_name: config vence DOM', {
        config_product_name: configured.product_name,
        fallback_product_name: fallbackName
      });
    }

    return {
      product_id: productId,
      product_slug: productSlug,
      product_name: productName,
      offer_id: offerId,
      price: parsedPrice.price,
      currency: currency
    };
  }

  function getContext(extra) {
    var pageLanguage = getPageLanguage();
    var browserLanguage = getBrowserLanguage();
    var browserLanguages = getBrowserLanguages();

    return Object.assign(
      {
        page_url: getCleanUrl(),
        referrer: document.referrer || 'direct',
        user_agent: navigator.userAgent || '',
        language: getPrimaryLanguage(),
        page_language: pageLanguage,
        browser_language: browserLanguage,
        browser_languages: browserLanguages,
        timezone: getTimezone(),
        platform: normalizeString(navigator.platform || ''),
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
      checkout: extractCheckoutData(),
      attribution: getAttribution(),
      context: getContext(contextExtra),
      schema_version: '1.1',
      script_version: VERSION
    };
  }

  function pushToDataLayer(eventData) {
    try {
      window.dataLayer = window.dataLayer || [];
      window.dataLayer.push(eventData);
    } catch (e) {
      log('Erro ao enviar para dataLayer', e);
    }
  }

  function getLegacyParamsFromAttribution(attribution) {
    var all = (attribution && attribution.all_params) || {};
    return {
      k_subid: all.k_subid || '',
      external_id: all.external_id || '',
      keyword: all.keyword || '',
      creative_id: all.creative_id || '',
      ad_campaign_id: all.ad_campaign_id || '',
      source: all.source || '',
      utm_source: all.utm_source || '',
      utm_campaign: all.utm_campaign || '',
      utm_medium: all.utm_medium || '',
      utm_term: all.utm_term || '',
      utm_content: all.utm_content || '',
      campaign_name: all.campaign_name || '',
      city: all.city || '',
      country: all.country || '',
      _subid: all._subid || '',
      vtid: all.vtid || '',
      device: all.device || '',
      adgroup_id: all.adgroup_id || ''
    };
  }

  function pushLegacyLeadCaptured(payload) {
    if (!enableLegacyDataLayerCompat) {
      return;
    }
    var name = splitName(payload.contact.name);
    var legacyParams = getLegacyParamsFromAttribution(payload.attribution);
    pushToDataLayer(
      Object.assign(
        {
          event: 'leadCaptured',
          email: payload.contact.email || '',
          customerName: payload.contact.name || '',
          firstName: name.firstName,
          lastName: name.lastName,
          productName: payload.checkout.product_name || '',
          urlSlug: payload.checkout.product_slug || getUrlSlug(),
          timestamp: currentIso(),
          event_source_url: getCleanUrl(),
          urlParams: payload.attribution.all_params || {},
          price: payload.checkout.price || 0,
          currency: payload.checkout.currency || '',
          product_id: payload.checkout.product_id || '',
          product_name: payload.checkout.product_name || ''
        },
        legacyParams
      )
    );
  }

  function pushLegacyAddPaymentInfo(payload, paymentMethod, buttonId, fieldsValid) {
    if (!enableLegacyDataLayerCompat) {
      return;
    }
    var name = splitName(payload.contact.name);
    var legacyParams = getLegacyParamsFromAttribution(payload.attribution);
    pushToDataLayer(
      Object.assign(
        {
          event: 'add_payment_info',
          email: payload.contact.email || '',
          customerName: payload.contact.name || '',
          firstName: name.firstName,
          lastName: name.lastName,
          productName: payload.checkout.product_name || '',
          price: payload.checkout.price || 0,
          currency: payload.checkout.currency || '',
          product_id: payload.checkout.product_id || '',
          product_name: payload.checkout.product_name || '',
          urlSlug: payload.checkout.product_slug || getUrlSlug(),
          paymentMethod: paymentMethod || 'unknown',
          buttonId: buttonId || '',
          fieldsValid: Boolean(fieldsValid),
          timestamp: currentIso(),
          event_source_url: getCleanUrl(),
          urlParams: payload.attribution.all_params || {}
        },
        legacyParams
      )
    );
  }

  function pushAllUrlParamsCaptured() {
    if (!enableLegacyDataLayerCompat) {
      return;
    }
    var params = getUrlParamsObject();
    var keys = Object.keys(params);
    if (!keys.length) {
      return;
    }
    pushToDataLayer(
      Object.assign(
        {
          event: 'allUrlParamsCaptured'
        },
        params
      )
    );
  }

  function addParamsToUrl(url, currentParams) {
    try {
      if (!url) {
        return url;
      }
      if (
        url.indexOf('#') === 0 ||
        url.indexOf('javascript:') === 0 ||
        url.indexOf('mailto:') === 0 ||
        url.indexOf('tel:') === 0
      ) {
        return url;
      }

      var urlObj = new URL(url, window.location.origin);
      currentParams.forEach(function (value, key) {
        if (!urlObj.searchParams.has(key)) {
          urlObj.searchParams.set(key, value);
        }
      });
      return urlObj.toString();
    } catch (e) {
      return url;
    }
  }

  function setupUrlParamPropagation() {
    if (!enableUrlParamPropagation || !hasAnyUrlParams()) {
      return;
    }

    var currentParams = new URLSearchParams(window.location.search);

    function patchLinks(root) {
      var scope = root && root.querySelectorAll ? root : document;
      var links = scope.querySelectorAll('a[href]');
      links.forEach(function (link) {
        if (link.hasAttribute('data-dsc-params-added')) {
          return;
        }
        var href = link.getAttribute('href');
        var next = addParamsToUrl(href, currentParams);
        if (next && next !== href) {
          link.setAttribute('href', next);
        }
        link.setAttribute('data-dsc-params-added', 'true');
      });
    }

    patchLinks(document);

    var linkObserver = new MutationObserver(function (mutations) {
      mutations.forEach(function (mutation) {
        mutation.addedNodes.forEach(function (node) {
          if (!node || node.nodeType !== 1) {
            return;
          }
          if (node.tagName === 'A') {
            patchLinks(node.parentNode || document);
            return;
          }
          patchLinks(node);
        });
      });
    });

    if (document.body) {
      linkObserver.observe(document.body, { childList: true, subtree: true });
    }
  }

  function prefillInputsFromStorage() {
    if (!enablePrefillFromStorage) {
      return;
    }
    var emailInput = document.querySelector(selectors.emailInput);
    var nameInput = document.querySelector(selectors.nameInput);

    if (emailInput && !normalizeString(emailInput.value)) {
      var savedEmail = normalizeString(safeLocalStorageGet(STORAGE.checkoutEmail));
      if (isValidEmail(savedEmail)) {
        emailInput.value = savedEmail;
      }
    }

    if (nameInput && !normalizeString(nameInput.value)) {
      var savedName = normalizeString(safeLocalStorageGet(STORAGE.checkoutName));
      if (savedName) {
        nameInput.value = savedName;
      }
    }
  }

  function persistIdentityToStorage() {
    if (!enablePrefillFromStorage) {
      return;
    }
    var email = getEmail();
    var name = getName();

    if (isValidEmail(email)) {
      safeLocalStorageSet(STORAGE.checkoutEmail, email);
    }
    if (normalizeString(name)) {
      safeLocalStorageSet(STORAGE.checkoutName, name);
    }
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

    pushToDataLayer({
      event: payload.event_name,
      dsc_session_id: payload.session_id,
      dsc_site_id: siteId,
      dsc_product_id: payload.checkout.product_id,
      dsc_product_slug: payload.checkout.product_slug,
      dsc_offer_id: payload.checkout.offer_id,
      dsc_language: payload.context.language
    });

    if (payload.event_name === 'checkout_identified') {
      pushLegacyLeadCaptured(payload);
    }

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
    persistIdentityToStorage();
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
    pushLegacyAddPaymentInfo(payload, getSelectedPaymentMethod(), button ? button.id || '' : '', fieldsValid);
  }

  function bindElement(element, eventName, handler) {
    if (!element || boundElements.has(element)) {
      return;
    }
    element.addEventListener(eventName, handler);
    boundElements.add(element);
  }

  function setupListeners() {
    // Dynamic checkout UIs can mount/re-mount inputs after initialization.
    prefillInputsFromStorage();

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
        persistIdentityToStorage();
      });
    }

    var nameInput = document.querySelector(selectors.nameInput);
    if (nameInput && !boundElements.has(nameInput)) {
      bindElement(nameInput, 'input', function () {
        persistIdentityToStorage();
      });
      bindElement(nameInput, 'blur', function () {
        persistIdentityToStorage();
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
    prefillInputsFromStorage();
    pushAllUrlParamsCaptured();
    setupUrlParamPropagation();
    setupListeners();
    setupObserver();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize);
  } else {
    initialize();
  }
})();
