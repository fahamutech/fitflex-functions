// Vendor smart import · every message the server says about an import, in English and Swahili.
// Keys are `vendor_import.<group>.<code>` (groups: issue, error, status, entity, field, csv). Placeholders: {name}.
// SWAHILI IS DRAFT: every `sw` text below is marked for native-speaker review (owner rule: Swahili drafts are
// reviewed before launch). Terms follow docs/localization/fitflex-terminology-glossary.md: Stock stays English, money is
// shown as TSh (TZS only in CSV column names), variant = chaguo, row = safu mlalo, column = safu wima, header = kichwa cha
// safu wima. {field} is replaced by the field's label in the message's own language. The apps translate by `code`;
// the server also returns `message: { en, sw }`.

export const SWAHILI_REVIEW_STATUS = 'draft_for_native_review';

/** severity per issue code: error → the row is invalid; warning → needs review; info → nothing to do. */
export const ISSUE_SEVERITY = Object.freeze({
  name_missing: 'error', name_too_long: 'error', price_invalid: 'error', price_not_whole_tzs: 'error',
  discount_not_below_price: 'error', stock_invalid: 'error', sku_exists: 'error', sku_duplicate_in_file: 'error',
  product_not_found: 'error', row_shape: 'error', sku_missing: 'error', sku_ambiguous: 'error',
  variant_required: 'error', variant_not_found: 'error', field_too_long: 'error', email_invalid: 'error',
  price_unusually_high: 'warning', stock_missing: 'warning', category_unknown: 'warning', name_exists: 'warning',
  formula_like_text: 'warning', cost_not_allowed: 'warning',
  image_not_supported: 'info', already_set: 'info',
});

const M = (en, sw) => Object.freeze({ en, sw });

export const MESSAGES = Object.freeze({
  // ── row issues ──
  'vendor_import.issue.name_missing': M('The product name is empty.', 'Jina la bidhaa halijajazwa.'),
  'vendor_import.issue.name_too_long': M('The name is longer than {max} characters.', 'Jina ni refu kuliko herufi {max}.'),
  'vendor_import.issue.price_invalid': M('The value in {field} is not a valid amount.', 'Thamani ya {field} si kiasi sahihi.'),
  'vendor_import.issue.price_not_whole_tzs': M('{field} must be a whole number (no decimals).', '{field} lazima iwe nambari kamili (bila desimali).'),
  'vendor_import.issue.discount_not_below_price': M('The discount price must be lower than the price.', 'Bei ya punguzo lazima iwe chini ya bei ya kawaida.'),
  'vendor_import.issue.stock_invalid': M('The value in {field} must be a whole number from 0 to 1,000,000.', 'Thamani ya {field} lazima iwe nambari kamili kati ya 0 na 1,000,000.'),
  'vendor_import.issue.sku_exists': M('You already have a product with this SKU.', 'Tayari una bidhaa yenye SKU hii.'),
  'vendor_import.issue.sku_duplicate_in_file': M('This SKU appears earlier in the file.', 'SKU hii imeonekana mapema kwenye faili.'),
  'vendor_import.issue.product_not_found': M('No product of yours has this SKU.', 'Hakuna bidhaa yako yenye SKU hii.'),
  'vendor_import.issue.row_shape': M('This row has {found} columns but the header row has {expected}.', 'Safu mlalo hii ina safu wima {found} lakini kichwa cha safu wima kina {expected}.'),
  'vendor_import.issue.sku_missing': M('The SKU is empty.', 'SKU haijajazwa.'),
  'vendor_import.issue.sku_ambiguous': M('More than one of your products has this SKU.', 'Zaidi ya bidhaa moja yako ina SKU hii.'),
  'vendor_import.issue.variant_required': M('This product keeps stock per variant: name the variant.', 'Bidhaa hii ina Stock kwa kila chaguo: taja chaguo.'),
  'vendor_import.issue.variant_not_found': M('The product has no variant with this name.', 'Bidhaa haina chaguo lenye jina hili.'),
  'vendor_import.issue.field_too_long': M('{field} is longer than {max} characters.', '{field} ni ndefu kuliko herufi {max}.'),
  'vendor_import.issue.email_invalid': M('The email address is not valid.', 'Anwani ya barua pepe si sahihi.'),
  'vendor_import.issue.price_unusually_high': M('The price is very high. Check it before importing.', 'Bei ni kubwa sana. Ihakiki kabla ya kuingiza.'),
  'vendor_import.issue.stock_missing': M('No stock quantity: it will start at 0.', 'Hakuna Stock: itaanza na 0.'),
  'vendor_import.issue.category_unknown': M('The category is not one of ours. It will be left empty. Closest: {suggestion}.', 'Aina ya bidhaa si miongoni mwa zetu. Itaachwa wazi. Karibu zaidi: {suggestionSw}.'),
  'vendor_import.issue.name_exists': M('You already have a product with this name.', 'Tayari una bidhaa yenye jina hili.'),
  'vendor_import.issue.formula_like_text': M('This text starts with = + - or @. It is kept as plain text.', 'Maandishi haya yanaanza na = + - au @. Yatabaki kama maandishi ya kawaida.'),
  'vendor_import.issue.cost_not_allowed': M('You may not set cost prices. The cost was ignored.', 'Huruhusiwi kuweka bei ya gharama. Gharama imepuuzwa.'),
  'vendor_import.issue.image_not_supported': M('Images are not imported yet. Add photos to the product afterwards.', 'Picha bado haziingizwi. Weka picha kwenye bidhaa baadaye.'),
  'vendor_import.issue.already_set': M('{field} is already filled in your profile and was not changed.', '{field} tayari imejazwa kwenye wasifu wako na haikubadilishwa.'),

  // ── request errors ──
  'vendor_import.error.feature_disabled': M('Smart import is not switched on.', 'Uingizaji wa haraka haujawashwa.'),
  'vendor_import.error.file_too_large': M('The file is larger than {maxMb} MB.', 'Faili ni kubwa kuliko MB {maxMb}.'),
  'vendor_import.error.too_many_rows': M('The file has more than {maxRows} rows.', 'Faili ina safu mlalo zaidi ya {maxRows}.'),
  'vendor_import.error.unsupported_file_type': M('Only CSV files are supported. Save your spreadsheet as CSV (UTF-8).', 'Faili za CSV pekee ndizo zinazokubaliwa. Hifadhi lahajedwali yako kama CSV (UTF-8).'),
  'vendor_import.error.invalid_encoding': M('The file is not valid UTF-8. Save it as CSV (UTF-8).', 'Faili si UTF-8 sahihi. Ihifadhi kama CSV (UTF-8).'),
  'vendor_import.error.duplicate_file': M('This exact file was already uploaded.', 'Faili hii hii ilishapakiwa.'),
  'vendor_import.error.apply_in_progress': M('This import is being applied right now.', 'Uingizaji huu unatekelezwa sasa hivi.'),
  'vendor_import.error.import_quota': M('Too many imports today or still open. Finish or discard one first.', 'Uingizaji mwingi leo au bado uko wazi. Maliza au futa mmoja kwanza.'),
  'vendor_import.error.rate_limited': M('Too many requests. Try again shortly.', 'Maombi mengi mno. Jaribu tena baada ya muda mfupi.'),
  'vendor_import.error.mapping_confirmation_required': M('Check the suggested columns and confirm them.', 'Hakiki safu wima zilizopendekezwa kisha uzithibitishe.'),
  'vendor_import.error.invalid_entity': M('Choose what you are importing: products, inventory or profile.', 'Chagua unachoingiza: bidhaa, Stock au wasifu.'),
  'vendor_import.error.invalid_lang': M('Language must be en or sw.', 'Lugha lazima iwe en au sw.'),
  'vendor_import.error.no_file_provided': M('No file was sent.', 'Hakuna faili iliyotumwa.'),
  'vendor_import.error.invalid_multipart': M('The upload could not be read.', 'Upakiaji haukuweza kusomwa.'),
  'vendor_import.error.invalid_csv': M('The CSV could not be read.', 'CSV haikuweza kusomwa.'),
  'vendor_import.error.empty_file': M('The file has no data rows.', 'Faili haina safu mlalo za data.'),
  'vendor_import.error.too_many_columns': M('The file has more than {maxColumns} columns.', 'Faili ina safu wima zaidi ya {maxColumns}.'),
  'vendor_import.error.cell_too_long': M('A cell is longer than {maxCellChars} characters.', 'Kisanduku kina herufi nyingi kuliko {maxCellChars}.'),
  'vendor_import.error.header_invalid': M('Column headers must be filled in and different from each other.', 'Majina ya safu wima lazima yajazwe na yawe tofauti.'),
  'vendor_import.error.profile_single_row': M('A profile file has exactly one data row.', 'Faili ya wasifu ina safu mlalo moja tu ya data.'),
  'vendor_import.error.import_not_found': M('Import not found.', 'Uingizaji haujapatikana.'),
  'vendor_import.error.batch_not_editable': M('This import can no longer be changed.', 'Uingizaji huu hauwezi kubadilishwa tena.'),
  'vendor_import.error.not_ready': M('This import is not ready to apply.', 'Uingizaji huu bado haujawa tayari kutekelezwa.'),
  'vendor_import.error.invalid_mapping': M('The column choices are not valid.', 'Chaguo za safu wima si sahihi.'),
  'vendor_import.error.duplicate_mapping': M('Two columns were matched to the same field.', 'Safu wima mbili zimeunganishwa na sehemu ileile.'),
  'vendor_import.error.critical_field_unmapped': M('Match the required columns first.', 'Unganisha safu wima zinazohitajika kwanza.'),
  'vendor_import.error.nothing_to_retry': M('No failed rows to retry.', 'Hakuna safu mlalo zilizoshindikana za kujaribu tena.'),
  'vendor_import.error.not_discardable': M('Rows were already imported, so this import cannot be discarded.', 'Safu mlalo zimeshaingizwa, kwa hiyo uingizaji huu hauwezi kufutwa.'),
  'vendor_import.error.vendor_permission_forbidden': M('You do not have permission to import.', 'Huna ruhusa ya kuingiza.'),
  'vendor_import.error.vendor_suspended': M('This vendor account is suspended.', 'Akaunti hii ya muuzaji imesimamishwa.'),
  'vendor_import.error.authorization_unavailable': M('Permissions could not be checked. Try again.', 'Ruhusa hazikuweza kukaguliwa. Jaribu tena.'),
  'vendor_import.error.invalid_status': M('Unknown status filter.', 'Kichujio cha hali hakijulikani.'),
  'vendor_import.error.invalid_apply_state': M('Unknown apply-state filter.', 'Kichujio cha hali ya uingizaji hakijulikani.'),
  'vendor_import.error.invalid_limit': M('Limit is not valid.', 'Kikomo si sahihi.'),
  'vendor_import.error.invalid_cursor': M('Cursor is not valid.', 'Kielekezi si sahihi.'),

  // ── batch status, entity, field names, errors.csv headings ──
  // ── reasons given with an error (`reason` / `hint` in the body) ──
  'vendor_import.error.reason.unterminated_quote': M('A quoted cell is never closed.', 'Kisanduku chenye nukuu hakijafungwa.'),
  'vendor_import.error.reason.empty_name': M('A column has no header.', 'Safu wima haina kichwa.'),
  'vendor_import.error.reason.duplicate_name': M('Two columns have the same header.', 'Safu wima mbili zina kichwa kilekile.'),
  'vendor_import.error.reason.header_only': M('The file has a header row but no data rows.', 'Faili ina kichwa cha safu wima tu, bila safu mlalo za data.'),
  'vendor_import.error.reason.daily': M('You reached today\'s limit of {max} imports.', 'Umefikia kikomo cha leo cha uingizaji {max}.'),
  'vendor_import.error.reason.open': M('You already have {max} unfinished imports.', 'Tayari una uingizaji {max} ambao haujakamilika.'),
  'vendor_import.error.reason.xlsx_not_supported_yet': M('Excel files are not supported yet: save as CSV (UTF-8).', 'Faili za Excel bado hazikubaliwi: zihifadhi kama CSV (UTF-8).'),
  'vendor_import.error.reason.binary_or_utf16': M('The file is not plain text: save as CSV (UTF-8).', 'Faili si maandishi ya kawaida: ihifadhi kama CSV (UTF-8).'),
  'vendor_import.error.reason.unknown_column': M('That column is not in the file.', 'Safu wima hiyo haimo kwenye faili.'),
  'vendor_import.error.reason.unknown_field': M('That field does not exist.', 'Sehemu hiyo haipo.'),
  'vendor_import.error.profile_import_owner_only': M('Only the account holder can import the business profile.', 'Ni mmiliki wa akaunti pekee anayeweza kuingiza wasifu wa biashara.'),
  'vendor_import.error.batch_expired': M('This import ended more than 30 days ago and its data was cleared. Upload the file again.', 'Uingizaji huu uliisha zaidi ya siku 30 zilizopita na data yake ilifutwa. Pakia faili tena.'),
  'vendor_import.error.import_busy': M('Imports are busy. Try again shortly.', 'Uingizaji una shughuli nyingi. Jaribu tena baada ya muda mfupi.'),
  'vendor_import.error.invalid_preset_id': M('The product could not be created.', 'Bidhaa haikuweza kuundwa.'),

  // ── why a row failed to apply (`lastError`) ──
  'vendor_import.row_error.stock_changed': M('Stock changed since the file was checked.', 'Stock ilibadilika tangu faili ilipokaguliwa.'),
  'vendor_import.row_error.sku_exists': M('A product with this SKU was added since the file was checked.', 'Bidhaa yenye SKU hii iliongezwa tangu faili ilipokaguliwa.'),
  'vendor_import.row_error.product_not_found': M('The product no longer exists.', 'Bidhaa haipo tena.'),
  'vendor_import.row_error.product_deleted': M('The product this row created was deleted. Retry will create it again.', 'Bidhaa iliyoundwa na safu mlalo hii ilifutwa. Kujaribu tena kutaiunda upya.'),
  'vendor_import.row_error.variant_not_found': M('The variant no longer exists.', 'Chaguo halipo tena.'),
  'vendor_import.row_error.insufficient_stock': M('Not enough Stock.', 'Stock haitoshi.'),
  'vendor_import.row_error.internal_error': M('Something went wrong. Try this row again.', 'Kuna hitilafu. Jaribu safu mlalo hii tena.'),
  'vendor_import.row_error.generic': M('This row could not be imported.', 'Safu mlalo hii haikuweza kuingizwa.'),

  'vendor_import.status.mapping_required': M('Match columns', 'Unganisha safu wima'),
  'vendor_import.status.ready': M('Ready to import', 'Tayari kuingizwa'),
  'vendor_import.status.applying': M('Importing', 'Inaingizwa'),
  'vendor_import.status.applied': M('Imported', 'Imeingizwa'),
  'vendor_import.status.partial': M('Partly imported', 'Imeingizwa kwa sehemu'),
  'vendor_import.status.discarded': M('Discarded', 'Imefutwa'),
  'vendor_import.entity.products': M('Products', 'Bidhaa'),
  'vendor_import.entity.inventory': M('Stock counts', 'Hesabu za Stock'),
  'vendor_import.entity.profile': M('Business profile', 'Wasifu wa biashara'),
  'vendor_import.field.name': M('Name', 'Jina'),
  'vendor_import.field.price_tzs': M('Price (TSh)', 'Bei (TSh)'),
  'vendor_import.field.stock': M('Stock', 'Stock'),
  'vendor_import.field.category': M('Category', 'Aina'),
  'vendor_import.field.description': M('Description', 'Maelezo'),
  'vendor_import.field.brand': M('Brand', 'Chapa'),
  'vendor_import.field.sku': M('SKU', 'SKU'),
  'vendor_import.field.discount_price_tzs': M('Discount price (TSh)', 'Bei ya punguzo (TSh)'),
  'vendor_import.field.cost_tzs': M('Cost (TSh)', 'Gharama (TSh)'),
  'vendor_import.field.reorder_level': M('Reorder level', 'Kiwango cha kuagiza'),
  'vendor_import.field.quantity': M('Quantity', 'Idadi'),
  'vendor_import.field.variant': M('Variant', 'Chaguo'),
  'vendor_import.field.businessName': M('Business name', 'Jina la biashara'),
  'vendor_import.field.businessCategory': M('Business category', 'Aina ya biashara'),
  'vendor_import.field.contactNumber': M('Contact number', 'Namba ya mawasiliano'),
  'vendor_import.field.email': M('Email', 'Barua pepe'),
  'vendor_import.field.address': M('Address', 'Anwani'),
  'vendor_import.field.businessHours': M('Business hours', 'Saa za kazi'),
  'vendor_import.field.image': M('Image (not imported)', 'Picha (haziingizwi)'),
  'vendor_import.csv.row': M('Row', 'Safu mlalo'),
  'vendor_import.csv.field': M('Field', 'Sehemu'),
  'vendor_import.csv.severity': M('Severity', 'Kiwango'),
  'vendor_import.csv.code': M('Code', 'Msimbo'),
  'vendor_import.csv.message_en': M('Message (English)', 'Ujumbe (Kiingereza)'),
  'vendor_import.csv.message_sw': M('Message (Swahili)', 'Ujumbe (Kiswahili)'),
  'vendor_import.csv.value': M('Value', 'Thamani'),
});

const mb = bytes => String(Math.round((Number(bytes) / (1024 * 1024)) * 10) / 10);

/**
 * Placeholders: {field} becomes the field's label in the message's own language (never the raw key); {maxMb} comes from
 * maxBytes; every other {name} is a plain parameter. Unknown or missing parameters render as empty text.
 */
function fill(text, params, lang) {
  return text.replace(/\{(\w+)\}/g, (whole, key) => {
    if (key === 'field' && params.field != null) return (MESSAGES[`vendor_import.field.${params.field}`] || { [lang]: String(params.field) })[lang];
    if (key === 'maxMb') return params.maxMb != null ? String(params.maxMb) : mb(params.maxBytes);
    return params[key] === undefined || params[key] === null ? '' : String(params[key]);
  });
}

/** { en, sw } for a key, placeholders filled per language; null when the key is unknown. */
export function messageFor(key, params = {}) {
  const m = MESSAGES[key];
  return m ? { en: fill(m.en, params, 'en'), sw: fill(m.sw, params, 'sw') } : null;
}
export const issueMessage = (code, params = {}) => messageFor(`vendor_import.issue.${code}`, params);
export const errorMessage = (code, params = {}) => messageFor(`vendor_import.error.${code}`, params);
/** The explanation of an error's `reason` (or `hint`), when there is one. */
export const reasonMessage = (reason, params = {}) => (reason ? messageFor(`vendor_import.error.reason.${reason}`, params) : null);
/** Why a row failed to apply: { code, message: { en, sw } } (a code without its own text gets the generic one). */
export const rowErrorView = code => (code ? { code, message: messageFor(`vendor_import.row_error.${code}`) || messageFor('vendor_import.row_error.generic') } : null);

/** An issue as the API returns it. */
export const issueView = issue => ({ ...issue, message: issueMessage(issue.code, { ...issue.params, field: issue.params?.field ?? issue.field }) });
