export type Lang = 'en' | 'es';

/**
 * Client-facing copy. Written for the client, in plain language, with no promises about outcomes.
 * Every key must exist in both languages (the Spanish table is typed against the English one).
 */
const EN = {
  home: 'Home', disputes: 'My items', documents: 'Documents', letters: 'Letters', messages: 'Messages', profile: 'Profile', signOut: 'Sign out',
  n_home: 'Home', n_items: 'Items', n_documents: 'Docs', n_letters: 'Letters', n_messages: 'Messages', n_profile: 'Profile',
  poweredBy: 'Secure client portal · Powered by',
  hello: 'Hello', welcomeSub: 'Here is where your case stands today.', journey: 'Your journey',
  s_intake: 'Getting started', s_analysis: 'Reviewing your reports', s_disputing: 'Disputing items', s_monitoring: 'Monitoring', s_graduated: 'Complete',
  sd_intake: 'We’re setting up your file — your agreements, ID and credit reports.',
  sd_analysis: 'Your specialist is checking every account on all three reports for anything that looks inaccurate or incomplete.',
  sd_disputing: 'We send dispute requests for the items you and your specialist agreed on, and follow each investigation.',
  sd_monitoring: 'We watch your reports for changes and follow up where it’s needed.',
  sd_graduated: 'Your current work with us is complete.',
  nextStep: 'Your next step', forYou: 'For you', forUs: 'On our side',
  ns_sign_t: 'Review and sign your agreement', ns_sign_b: 'We can’t start work until your agreements are signed. It takes about two minutes.',
  ns_upload_t: 'Upload what we asked for', ns_upload_b: 'We’re waiting on documents from you before we can continue. You can upload them right here, even from your phone.',
  ns_review_t: 'A response came back', ns_review_b: 'We received a response on one of your items and your specialist is reviewing it. Nothing is needed from you.',
  ns_wait_t: 'The investigation is under way', ns_wait_b: 'Companies usually have 30 days to investigate a dispute. The next response is expected around',
  ns_prep_t: 'We’re working on your file', ns_prep_b: 'Your specialist is going through your reports. You’ll see each item here as soon as it’s sent.',
  ns_done_t: 'Nothing is waiting right now', ns_done_b: 'All current items have an answer. We’ll post here if anything changes.',
  ns_late: 'If a response is late, your specialist follows up for you.',
  daysAway: 'days away', today: 'today', uploadNow: 'Upload now', messageTo: 'Message', messageTeam: 'Message your team',
  needFromYou: 'What we need from you', nothingNeeded: 'Nothing needed right now — we’ll let you know if that changes.', upload: 'Upload', sign: 'Review & sign',
  progress: 'Progress', itemsSent: 'Items sent', changed: 'Removed or corrected', verified: 'Verified as reported', waiting: 'Still under review',
  progressNote: 'Results vary. Every decision is made by the credit bureaus and the companies that report to them — not by us — and nothing here is a promise of a future outcome.',
  latest: 'Latest updates', noUpdates: 'No updates yet. We’ll post them here as things happen.', specialist: 'Your specialist',
  st_approved: 'Ready to send', st_submitted: 'Sent', st_under_investigation: 'Being investigated', st_response_received: 'Response received', st_resolved: 'Complete', st_on_hold: 'Paused',
  m_approved: 'Your specialist approved this request. It will be sent soon.', m_submitted: 'We sent this request. The company has about 30 days to investigate.', m_under_investigation: 'The company is investigating.', m_response_received: 'We received a response and are reviewing it.', m_resolved: 'This item is complete.', m_on_hold: 'This item is paused for now. Your specialist can tell you why.',
  o_deleted: 'Removed from your report', o_updated: 'Corrected', o_verified: 'Kept as reported after investigation', o_unresolved: 'Not resolved yet', o_no_response: 'No response received',
  freeReportTitle: 'Send us your free credit reports', freeReport1: 'Get your free reports from all three bureaus at', freeReport2: 'Save each report as a PDF (use “Print” then “Save as PDF” if there is no download button).', freeReport3: 'Upload each PDF here and choose “Credit report”.',
  freeReportNote: 'The reports are free once a week and checking them does not affect your credit. A photo or screenshot cannot be read automatically, so please send the PDF.',
  monitoringOptional: 'optional paid monitoring', monitoringBody: 'A paid service some people use to view their reports online. It is optional: you do not need it to work with us, and your free reports from AnnualCreditReport.com work just as well.', monitoringOpen: 'Open',
  monitoringDisclosure: 'may earn a commission if you sign up.', monitoringDefaultLabel: 'Credit monitoring',
  kind_id: 'Photo ID', kind_proof_of_address: 'Proof of address', kind_ssn_proof: 'Proof of SSN', kind_credit_report: 'Credit report', kind_bureau_response: 'Bureau response',
  kind_ftc_report: 'FTC identity theft report', kind_police_report: 'Police report', kind_contract: 'Contract', kind_evidence: 'Supporting evidence', kind_other: 'Other',
  byStaff: 'recorded by your specialist', byCarrier: 'confirmed by the mail carrier',
  sentOn: 'Sent', expectBy: 'Response expected by', reason: 'What we asked', noDisputes: 'No items have been sent yet. We’ll show them here once we submit your first dispute.',
  scoresTitle: 'Your reported scores', scoresNote: 'Shown exactly as stated on your credit reports. Scores move for many reasons and are not a prediction or a promise.',
  uploaded: 'Your uploads', uploadedOk: 'Uploaded — thank you', uploadedOkBody: 'Your specialist has been notified.', noDocs: 'You haven’t uploaded anything yet.', requested: 'Requested', received: 'Received', docType: 'What is it?', chooseFile: 'Choose a file', uploadHelp: 'PDF, PNG or JPG, up to 10 MB. Your files are stored encrypted.',
  noLetters: 'No approved letters yet. Letters appear here after your specialist reviews and approves them.', download: 'Download PDF',
  messagesTitle: 'Messages with your specialist', noMessages: 'No messages yet — send one below.', writeMessage: 'Write a message', send: 'Send', you: 'You', team: 'Your team',
  contact: 'Contact details', phone: 'Phone', address: 'Mailing address', language: 'Language', save: 'Save changes', email: 'Email', emailNote: 'To change your email, ask your specialist.',
  agreements: 'Agreements', signed: 'Signed', notSigned: 'Needs your signature', typeName: 'Type your full legal name to sign', agree: 'I have read this and agree', signNow: 'Sign',
  security: 'Security', twoStep: 'Turn on two-step verification', changePassword: 'Change password',
  rightsTitle: 'Your rights', rightsIntro: 'These apply whether or not you work with us.',
  r_free: 'You can get free credit reports from all three bureaus every week at AnnualCreditReport.com.',
  r_diy: 'You can dispute inaccurate information with the credit bureaus yourself, at no cost.',
  r_accurate: 'No one — including us — can legally have information removed that is accurate, current and verifiable.',
  r_time: 'Bureaus generally have 30 days to investigate a dispute (up to 45 in some cases).',
  r_cancel: 'You can cancel your service agreement without penalty within 3 business days of signing it.',
  rightsMore: 'Learn more from the Consumer Financial Protection Bureau',
  disclaimer: 'Your specialist is not a law firm and cannot guarantee any result. You can cancel your service agreement within 3 business days of signing, and you can dispute information with the credit bureaus yourself at no cost.',
  // Profile, items and home details
  city: 'City', state: 'State', zip: 'ZIP', currentPassword: 'Current password', newPassword: 'New password', confirmPassword: 'Confirm new password', passwordHint: 'At least 10 characters',
  twoStepOn: 'Two-step verification is on', readAgreement: 'Read', round: 'Round', dayAway: 'day away', password: 'Password', sending: 'Sending…',
  agreementLangNote: 'The agreement text is in English. If you need help understanding it, message your specialist before you sign.',
  consent_croa_disclosure_title: 'Consumer Credit File Rights (CROA disclosure)', consent_croa_contract_title: 'Service agreement',
  consent_fcra_authorization_title: 'Authorization to review credit reports and dispute on my behalf', consent_esign_title: 'Electronic records and signatures',
  consent_communications_title: 'Communication preferences', consent_data_processing_title: 'How my information is used',
  // Results of the client's own actions
  a_messageSent: 'Message sent. Your specialist will reply here.', a_saved: 'Saved.', a_confirmAgree: 'Please confirm you have read and agree.',
  a_legalName: 'Please type your full legal name as it appears on your account.', a_alreadySigned: 'You have already signed this.', a_signedOk: 'Signed. Thank you.',
  a_pwMismatch: 'The new passwords do not match.', a_pwChanged: 'Password changed.',
  // Messages produced by shared server code. The English text must match the source exactly: portalMessage() looks them up by it.
  e_required: 'Please fill in every required field.', e_checkForm: 'Please check the form and try again.', e_state: 'Use a two-letter state code', e_zip: 'Use a 5-digit ZIP',
  e_fileMissing: 'Choose a file to upload.', e_fileTooLarge: 'That file is larger than 10 MB.', e_fileType: 'That file type is not accepted. Please upload a PDF, PNG or JPG.',
  e_generic: 'Something went wrong. Please try again.', e_noAccess: 'You do not have access to that record.', e_exists: 'That already exists.',
  e_pwCurrent: 'Your current password is incorrect.', e_pwShort: 'Use at least 10 characters.', e_pwLong: 'Use 128 characters or fewer.', e_pwCommon: 'That password is too common.',
  e_pwRepeat: 'Avoid repeating a single character.', e_pwEmail: 'Do not include your email name in the password.', e_pwVaried: 'Use a more varied password.',
  e_login: 'Incorrect email or password.', e_locked: 'This account is temporarily locked after repeated failures. Try again later or reset your password.',
  e_staffHere: 'This sign-in is for clients. Staff sign in at /login.', e_tooMany: 'Too many attempts. Try again later.', e_tooManyMin: 'Too many attempts. Try again in {n} minute(s).',
  e_inviteInvalid: 'This invitation is invalid or has expired.', e_inviteExisting: 'An account with this email exists; enter its current password to join.',
  e_email: 'Enter a valid email address', e_enterPassword: 'Enter your password', e_name: 'Enter your name', e_contactConsent: 'Please confirm we may contact you',
  e_formUnavailable: 'This form is not available.', e_code: 'Enter the 6-digit code', e_codeInvalid: 'That code is not valid. Check your authenticator app and try again.',
  e_resetSent: 'If an account exists for that email, a reset link is on its way. It expires in 1 hour.',
  // Error screens
  err_title: 'Something went wrong', err_body: 'This page could not be loaded or your last action did not go through. Please try again. If you were uploading a file, make sure it is smaller than 10 MB.',
  err_retry: 'Try again', err_rootBody: 'Please try again. If it keeps happening, reload the page.', err_home: 'Go to the home page',
  // Sign-in, password reset and invitation
  li_title: 'Your client portal', li_welcomeBack: 'Welcome back', li_subBrand: 'Sign in to see your progress with {org}, upload documents and message your specialist.',
  li_sub: 'Check progress, upload documents and message your specialist.', li_workHere: 'Work here?', li_staff: 'Staff sign in',
  li_noRecord: 'We could not find a client record for this account. Contact your specialist.', li_reset: 'Password updated. Sign in with your new password.',
  li_forgot: 'Forgot password?', li_signIn: 'Sign in', li_signingIn: 'Signing in…', li_newHere: 'New here? {org} will email you an invitation to create your portal account.', li_yourSpecialist: 'Your specialist',
  fp_title: 'Reset your password', fp_sub: 'Enter your email and we will send you a link.', fp_send: 'Send reset link', fp_back: 'Back to sign in', fp_portalLink: 'Client portal sign in',
  inv_welcome: 'Welcome', inv_sub: '{org} has invited you to your secure client portal.', inv_name: 'Your name',
  inv_pwHint: 'At least 10 characters, not used anywhere else. If you already have a portal account with this email, enter that password.', inv_accept: 'Accept invitation', inv_settingUp: 'Setting up…',
  // Agency enquiry form
  lead_title: 'A home, a car, a better card — it starts with accurate credit', lead_sub: 'Tell {org} what you’re working toward and how to reach you. There is no cost and no obligation to ask.',
  lead_already: 'Already a client?', lead_signIn: 'Sign in to your portal', lead_optional: 'Optional', lead_goal: 'What are you working toward?', lead_choose: 'Choose…',
  goal_home: 'Buying a home', goal_car: 'Getting a car', goal_card: 'Qualifying for a credit card', goal_rent: 'Renting an apartment', goal_rates: 'Lower interest rates', goal_business: 'Starting a business', goal_other: 'Something else',
  lead_lang: 'Preferred language', lead_message: 'What would you like help with?', lead_messageHint: 'Optional. Please don’t include your Social Security number or account numbers here.',
  lead_consent: 'I agree that {org} may contact me about its services using the details above.',
  lead_legal: 'Asking is free. We help you check your reports and dispute what is inaccurate; lenders make their own decisions, so no one can promise an approval, a specific result or a higher credit score, and you have the right to dispute inaccurate information with the credit bureaus yourself at no cost.',
  lead_thanksTitle: 'Thank you — we’ve got it', lead_thanksSub: 'Someone from {org} will contact you soon. You don’t need to do anything else for now.',
  lead_thanksNote: 'Your details were sent securely. Please don’t email sensitive information such as your Social Security number.',
  // Side panel of the sign-in pages
  al_tagline: 'See exactly where every item stands — no guessing, no chasing.', al_secure: 'Secure client portal',
  al_p1: 'Plain-language updates on every item — what was sent, when, and what came back.', al_p2: 'Upload documents and sign agreements from your phone.',
  al_p3: 'Message your specialist directly. Every answer stays in one place.', al_p4: 'Your files are encrypted. Only you and your specialist’s team can see them.',
  // Two-step verification (client wording)
  mfa_enterTitle: 'Enter your code', mfa_enterSub: 'Open your authenticator app and type the 6-digit code for your {org} portal.', mfa_code: '6-digit code', mfa_verify: 'Verify', mfa_verifying: 'Verifying…',
  mfa_other: 'Use a different account', mfa_setupTitle: 'Protect your account', mfa_setupSub: 'Add a second step to protect your account. After your password, you will enter a code from an app on your phone.',
  mfa_s1: 'Open an authenticator app (1Password, Google Authenticator, Authy…) and add a new account using “enter a setup key”.', mfa_s2: 'Use this key:',
  mfa_s2meta: 'Account: {email} · Type: time-based · 6 digits', mfa_s3: 'Enter the 6-digit code it shows:', mfa_notNow: 'Not now',
} as const;

export type PortalKey = keyof typeof EN;

const ES: Record<PortalKey, string> = {
  home: 'Inicio', disputes: 'Mis cuentas', documents: 'Documentos', letters: 'Cartas', messages: 'Mensajes', profile: 'Perfil', signOut: 'Cerrar sesión',
  n_home: 'Inicio', n_items: 'Cuentas', n_documents: 'Docs', n_letters: 'Cartas', n_messages: 'Mensajes', n_profile: 'Perfil',
  poweredBy: 'Portal seguro para clientes · Con tecnología de',
  hello: 'Hola', welcomeSub: 'Así va su caso hoy.', journey: 'Su proceso',
  s_intake: 'Comenzando', s_analysis: 'Revisando sus informes', s_disputing: 'Disputando cuentas', s_monitoring: 'Seguimiento', s_graduated: 'Completo',
  sd_intake: 'Estamos preparando su expediente: sus acuerdos, identificación e informes de crédito.',
  sd_analysis: 'Su especialista revisa cada cuenta en los tres informes para detectar información que parezca inexacta o incompleta.',
  sd_disputing: 'Enviamos solicitudes de disputa por las cuentas acordadas con su especialista y damos seguimiento a cada investigación.',
  sd_monitoring: 'Vigilamos sus informes por cambios y damos seguimiento cuando hace falta.',
  sd_graduated: 'Su trabajo actual con nosotros está completo.',
  nextStep: 'Su próximo paso', forYou: 'Para usted', forUs: 'De nuestra parte',
  ns_sign_t: 'Revise y firme su acuerdo', ns_sign_b: 'No podemos empezar hasta que sus acuerdos estén firmados. Toma unos dos minutos.',
  ns_upload_t: 'Suba lo que le pedimos', ns_upload_b: 'Estamos esperando documentos suyos para poder continuar. Puede subirlos aquí mismo, incluso desde su teléfono.',
  ns_review_t: 'Llegó una respuesta', ns_review_b: 'Recibimos una respuesta sobre una de sus cuentas y su especialista la está revisando. No necesita hacer nada.',
  ns_wait_t: 'La investigación está en curso', ns_wait_b: 'Las empresas suelen tener 30 días para investigar una disputa. La próxima respuesta se espera alrededor del',
  ns_prep_t: 'Estamos trabajando en su expediente', ns_prep_b: 'Su especialista está revisando sus informes. Verá cada cuenta aquí en cuanto se envíe.',
  ns_done_t: 'No hay nada pendiente ahora', ns_done_b: 'Todas las cuentas actuales tienen respuesta. Le avisaremos aquí si algo cambia.',
  ns_late: 'Si una respuesta se retrasa, su especialista da seguimiento por usted.',
  daysAway: 'días', today: 'hoy', uploadNow: 'Subir ahora', messageTo: 'Escribir a', messageTeam: 'Escribir a su equipo',
  needFromYou: 'Lo que necesitamos de usted', nothingNeeded: 'Por ahora no necesitamos nada — le avisaremos si cambia.', upload: 'Subir', sign: 'Revisar y firmar',
  progress: 'Progreso', itemsSent: 'Cuentas enviadas', changed: 'Eliminadas o corregidas', verified: 'Verificadas tal como estaban', waiting: 'Aún en revisión',
  progressNote: 'Los resultados varían. Cada decisión la toman las agencias de crédito y las empresas que reportan, no nosotros, y nada aquí es una promesa de resultados futuros.',
  latest: 'Últimas novedades', noUpdates: 'Aún no hay novedades. Las publicaremos aquí.', specialist: 'Su especialista',
  st_approved: 'Lista para enviar', st_submitted: 'Enviada', st_under_investigation: 'En investigación', st_response_received: 'Respuesta recibida', st_resolved: 'Completa', st_on_hold: 'En pausa',
  m_approved: 'Su especialista aprobó esta solicitud. Se enviará pronto.', m_submitted: 'Enviamos esta solicitud. La empresa tiene unos 30 días para investigar.', m_under_investigation: 'La empresa está investigando.', m_response_received: 'Recibimos una respuesta y la estamos revisando.', m_resolved: 'Esta cuenta está completa.', m_on_hold: 'Esta cuenta está en pausa por ahora. Su especialista puede explicarle por qué.',
  o_deleted: 'Eliminada de su informe', o_updated: 'Corregida', o_verified: 'Se mantuvo tal como estaba tras la investigación', o_unresolved: 'Aún sin resolver', o_no_response: 'Sin respuesta',
  freeReportTitle: 'Envíenos sus informes de crédito gratuitos', freeReport1: 'Obtenga sus informes gratuitos de las tres agencias en', freeReport2: 'Guarde cada informe como PDF (use “Imprimir” y luego “Guardar como PDF” si no hay botón de descarga).', freeReport3: 'Suba cada PDF aquí y elija “Informe de crédito”.',
  freeReportNote: 'Los informes son gratuitos una vez por semana y consultarlos no afecta su crédito. Una foto o captura de pantalla no se puede leer automáticamente; envíe el PDF.',
  monitoringOptional: 'monitoreo de pago opcional', monitoringBody: 'Un servicio de pago que algunas personas usan para ver sus informes en línea. Es opcional: no lo necesita para trabajar con nosotros, y sus informes gratuitos de AnnualCreditReport.com funcionan igual de bien.', monitoringOpen: 'Abrir',
  monitoringDisclosure: 'puede recibir una comisión si usted se suscribe.', monitoringDefaultLabel: 'Monitoreo de crédito',
  kind_id: 'Identificación con foto', kind_proof_of_address: 'Comprobante de domicilio', kind_ssn_proof: 'Comprobante de número de Seguro Social', kind_credit_report: 'Informe de crédito', kind_bureau_response: 'Respuesta de la agencia de crédito',
  kind_ftc_report: 'Informe de robo de identidad de la FTC', kind_police_report: 'Informe policial', kind_contract: 'Contrato', kind_evidence: 'Documentos de respaldo', kind_other: 'Otro',
  byStaff: 'registrado por su especialista', byCarrier: 'confirmado por el servicio de correo',
  sentOn: 'Enviada', expectBy: 'Respuesta esperada para', reason: 'Lo que pedimos', noDisputes: 'Aún no se ha enviado ninguna cuenta. Las verá aquí cuando enviemos su primera disputa.',
  scoresTitle: 'Sus puntajes reportados', scoresNote: 'Tal como aparecen en sus informes de crédito. Los puntajes cambian por muchas razones y no son una predicción ni una promesa.',
  uploaded: 'Sus archivos', uploadedOk: 'Subido — gracias', uploadedOkBody: 'Su especialista ha sido notificado.', noDocs: 'Aún no ha subido nada.', requested: 'Solicitado', received: 'Recibido', docType: '¿Qué es?', chooseFile: 'Elija un archivo', uploadHelp: 'PDF, PNG o JPG, hasta 10 MB. Sus archivos se guardan cifrados.',
  noLetters: 'Aún no hay cartas aprobadas. Aparecerán aquí cuando su especialista las revise y apruebe.', download: 'Descargar PDF',
  messagesTitle: 'Mensajes con su especialista', noMessages: 'Aún no hay mensajes — envíe uno abajo.', writeMessage: 'Escriba un mensaje', send: 'Enviar', you: 'Usted', team: 'Su equipo',
  contact: 'Datos de contacto', phone: 'Teléfono', address: 'Dirección postal', language: 'Idioma', save: 'Guardar cambios', email: 'Correo', emailNote: 'Para cambiar su correo, pídaselo a su especialista.',
  agreements: 'Acuerdos', signed: 'Firmado', notSigned: 'Necesita su firma', typeName: 'Escriba su nombre legal completo para firmar', agree: 'Lo he leído y estoy de acuerdo', signNow: 'Firmar',
  security: 'Seguridad', twoStep: 'Activar verificación en dos pasos', changePassword: 'Cambiar contraseña',
  rightsTitle: 'Sus derechos', rightsIntro: 'Esto aplica trabaje o no con nosotros.',
  r_free: 'Puede obtener informes de crédito gratuitos de las tres agencias cada semana en AnnualCreditReport.com.',
  r_diy: 'Puede disputar información inexacta directamente con las agencias de crédito, sin costo.',
  r_accurate: 'Nadie, incluidos nosotros, puede hacer eliminar legalmente información que sea exacta, actual y verificable.',
  r_time: 'Las agencias generalmente tienen 30 días para investigar una disputa (hasta 45 en algunos casos).',
  r_cancel: 'Puede cancelar su contrato de servicios sin penalidad dentro de los 3 días hábiles posteriores a su firma.',
  rightsMore: 'Más información de la Oficina para la Protección Financiera del Consumidor (CFPB)',
  disclaimer: 'Su especialista no es un bufete de abogados y no puede garantizar ningún resultado. Puede cancelar su contrato dentro de los 3 días hábiles posteriores a la firma, y puede disputar información con las agencias de crédito usted mismo sin costo.',
  city: 'Ciudad', state: 'Estado', zip: 'C. postal', currentPassword: 'Contraseña actual', newPassword: 'Contraseña nueva', confirmPassword: 'Confirme la contraseña nueva', passwordHint: 'Al menos 10 caracteres',
  twoStepOn: 'Verificación en dos pasos activada', readAgreement: 'Leer', round: 'Ronda', dayAway: 'día', password: 'Contraseña', sending: 'Enviando…',
  agreementLangNote: 'El texto del acuerdo está en inglés. Si necesita ayuda para entenderlo, escriba a su especialista antes de firmar.',
  consent_croa_disclosure_title: 'Derechos del consumidor sobre su expediente de crédito (divulgación CROA)', consent_croa_contract_title: 'Contrato de servicios',
  consent_fcra_authorization_title: 'Autorización para revisar mis informes de crédito y disputar en mi nombre', consent_esign_title: 'Registros y firmas electrónicos',
  consent_communications_title: 'Preferencias de comunicación', consent_data_processing_title: 'Cómo se usa mi información',
  a_messageSent: 'Mensaje enviado. Su especialista le responderá aquí.', a_saved: 'Guardado.', a_confirmAgree: 'Confirme que lo ha leído y que está de acuerdo.',
  a_legalName: 'Escriba su nombre legal completo tal como aparece en su cuenta.', a_alreadySigned: 'Ya firmó este acuerdo.', a_signedOk: 'Firmado. Gracias.',
  a_pwMismatch: 'Las contraseñas nuevas no coinciden.', a_pwChanged: 'Contraseña cambiada.',
  e_required: 'Complete todos los campos obligatorios.', e_checkForm: 'Revise el formulario e inténtelo de nuevo.', e_state: 'Use el código de estado de dos letras', e_zip: 'Use un código postal de 5 dígitos',
  e_fileMissing: 'Elija un archivo para subir.', e_fileTooLarge: 'Ese archivo pesa más de 10 MB.', e_fileType: 'Ese tipo de archivo no se acepta. Suba un PDF, PNG o JPG.',
  e_generic: 'Algo salió mal. Inténtelo de nuevo.', e_noAccess: 'No tiene acceso a ese registro.', e_exists: 'Eso ya existe.',
  e_pwCurrent: 'Su contraseña actual es incorrecta.', e_pwShort: 'Use al menos 10 caracteres.', e_pwLong: 'Use 128 caracteres o menos.', e_pwCommon: 'Esa contraseña es demasiado común.',
  e_pwRepeat: 'Evite repetir un solo carácter.', e_pwEmail: 'No incluya el nombre de su correo en la contraseña.', e_pwVaried: 'Use una contraseña más variada.',
  e_login: 'Correo o contraseña incorrectos.', e_locked: 'Esta cuenta está bloqueada temporalmente tras varios intentos fallidos. Inténtelo más tarde o restablezca su contraseña.',
  e_staffHere: 'Este acceso es para clientes. El personal inicia sesión en /login.', e_tooMany: 'Demasiados intentos. Inténtelo más tarde.', e_tooManyMin: 'Demasiados intentos. Inténtelo de nuevo en {n} minuto(s).',
  e_inviteInvalid: 'Esta invitación no es válida o ya venció.', e_inviteExisting: 'Ya existe una cuenta con este correo; escriba su contraseña actual para continuar.',
  e_email: 'Escriba un correo electrónico válido', e_enterPassword: 'Escriba su contraseña', e_name: 'Escriba su nombre', e_contactConsent: 'Confirme que podemos comunicarnos con usted',
  e_formUnavailable: 'Este formulario no está disponible.', e_code: 'Escriba el código de 6 dígitos', e_codeInvalid: 'Ese código no es válido. Revise su aplicación de autenticación e inténtelo de nuevo.',
  e_resetSent: 'Si existe una cuenta con ese correo, le enviamos un enlace para restablecer la contraseña. Vence en 1 hora.',
  err_title: 'Algo salió mal', err_body: 'No se pudo cargar esta página o su última acción no se completó. Inténtelo de nuevo. Si estaba subiendo un archivo, asegúrese de que pese menos de 10 MB.',
  err_retry: 'Intentar de nuevo', err_rootBody: 'Inténtelo de nuevo. Si sigue ocurriendo, recargue la página.', err_home: 'Ir a la página de inicio',
  li_title: 'Su portal de clientes', li_welcomeBack: 'Le damos la bienvenida de nuevo', li_subBrand: 'Inicie sesión para ver su progreso con {org}, subir documentos y escribir a su especialista.',
  li_sub: 'Consulte su progreso, suba documentos y escriba a su especialista.', li_workHere: '¿Trabaja aquí?', li_staff: 'Acceso del personal',
  li_noRecord: 'No encontramos un expediente de cliente para esta cuenta. Comuníquese con su especialista.', li_reset: 'Contraseña actualizada. Inicie sesión con su contraseña nueva.',
  li_forgot: '¿Olvidó su contraseña?', li_signIn: 'Iniciar sesión', li_signingIn: 'Iniciando sesión…', li_newHere: '¿Es nuevo aquí? {org} le enviará por correo una invitación para crear su cuenta del portal.', li_yourSpecialist: 'Su especialista',
  fp_title: 'Restablezca su contraseña', fp_sub: 'Escriba su correo y le enviaremos un enlace.', fp_send: 'Enviar enlace', fp_back: 'Volver a iniciar sesión', fp_portalLink: 'Acceso al portal de clientes',
  inv_welcome: 'Le damos la bienvenida', inv_sub: '{org} le ha invitado a su portal seguro para clientes.', inv_name: 'Su nombre',
  inv_pwHint: 'Al menos 10 caracteres, que no use en ningún otro sitio. Si ya tiene una cuenta del portal con este correo, escriba esa contraseña.', inv_accept: 'Aceptar invitación', inv_settingUp: 'Preparando…',
  lead_title: 'Una casa, un auto, una mejor tarjeta: todo empieza con un informe de crédito exacto', lead_sub: 'Cuéntele a {org} cuál es su meta y cómo comunicarnos con usted. Preguntar no tiene costo ni compromiso.',
  lead_already: '¿Ya es cliente?', lead_signIn: 'Inicie sesión en su portal', lead_optional: 'Opcional', lead_goal: '¿Cuál es su meta?', lead_choose: 'Elija…',
  goal_home: 'Comprar una casa', goal_car: 'Conseguir un auto', goal_card: 'Calificar para una tarjeta de crédito', goal_rent: 'Alquilar un apartamento', goal_rates: 'Tasas de interés más bajas', goal_business: 'Empezar un negocio', goal_other: 'Otra cosa',
  lead_lang: 'Idioma preferido', lead_message: '¿Con qué le gustaría recibir ayuda?', lead_messageHint: 'Opcional. No incluya aquí su número de Seguro Social ni números de cuenta.',
  lead_consent: 'Acepto que {org} se comunique conmigo sobre sus servicios usando los datos anteriores.',
  lead_legal: 'Preguntar es gratis. Le ayudamos a revisar sus informes y a disputar lo que sea inexacto; los prestamistas toman sus propias decisiones, así que nadie puede prometer una aprobación, un resultado específico ni un puntaje de crédito más alto, y usted tiene derecho a disputar información inexacta directamente con las agencias de crédito sin costo.',
  lead_thanksTitle: 'Gracias — lo recibimos', lead_thanksSub: 'Alguien de {org} se comunicará con usted pronto. Por ahora no necesita hacer nada más.',
  lead_thanksNote: 'Sus datos se enviaron de forma segura. No envíe por correo electrónico información sensible, como su número de Seguro Social.',
  al_tagline: 'Vea exactamente cómo va cada cuenta, sin adivinar ni tener que preguntar.', al_secure: 'Portal seguro para clientes',
  al_p1: 'Novedades en lenguaje sencillo sobre cada cuenta: qué se envió, cuándo y qué respondieron.', al_p2: 'Suba documentos y firme acuerdos desde su teléfono.',
  al_p3: 'Escriba directamente a su especialista. Todas las respuestas quedan en un solo lugar.', al_p4: 'Sus archivos están cifrados. Solo usted y el equipo de su especialista pueden verlos.',
  mfa_enterTitle: 'Escriba su código', mfa_enterSub: 'Abra su aplicación de autenticación y escriba el código de 6 dígitos de su portal de {org}.', mfa_code: 'Código de 6 dígitos', mfa_verify: 'Verificar', mfa_verifying: 'Verificando…',
  mfa_other: 'Usar otra cuenta', mfa_setupTitle: 'Proteja su cuenta', mfa_setupSub: 'Agregue un segundo paso para proteger su cuenta. Después de su contraseña, escribirá un código de una aplicación en su teléfono.',
  mfa_s1: 'Abra una aplicación de autenticación (1Password, Google Authenticator, Authy…) y agregue una cuenta nueva con la opción “ingresar una clave de configuración”.', mfa_s2: 'Use esta clave:',
  mfa_s2meta: 'Cuenta: {email} · Tipo: basado en tiempo · 6 dígitos', mfa_s3: 'Escriba el código de 6 dígitos que muestra:', mfa_notNow: 'Ahora no',
};

export const tr = (lang: Lang) => (k: PortalKey): string => (lang === 'es' ? ES[k] : EN[k]);

/** Language from an untrusted value (a query parameter or a hidden form field). Anything but "es" is English. */
export const parseLang = (v: unknown): Lang => (v === 'es' ? 'es' : 'en');

/** Fills `{name}` placeholders in a translated string. */
export const fill = (s: string, vars: Record<string, string | number>): string => s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));

/** Query string for links between the public client pages; empty values are left out. */
export function qs(params: Record<string, string | null | undefined | false>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) u.set(k, v);
  const out = u.toString();
  return out ? `?${out}` : '';
}

// Shared server code (password rules, upload checks, sign-in) reports problems in English. These tables find the
// matching portal key by that English text, so a client sees the message in their own language.
const SERVER_MESSAGE_KEY = new Map<string, PortalKey>([
  ...(Object.keys(EN) as PortalKey[]).filter((k) => k.startsWith('e_')).map((k) => [EN[k], k] as [string, PortalKey]),
  ['required', 'e_required'], ['Too many requests. Please try again later.', 'e_tooMany'],
]);
const SERVER_MESSAGE_PREFIX: [string, PortalKey][] = [['That file type is not accepted', 'e_fileType'], ['Too many', 'e_tooMany']];

/**
 * Turns a message from shared server code into the client's language. A form-validation message arrives as
 * "field: problem"; the field name is internal, so it is dropped. A message this table does not know is returned as is.
 */
export function portalMessage(lang: Lang, message: string): string {
  const t = tr(lang);
  const minutes = /^Too many attempts\. Try again in (\d+) minute/.exec(message);
  if (minutes) return fill(t('e_tooManyMin'), { n: minutes[1]! });
  const known = (m: string) => SERVER_MESSAGE_KEY.get(m) ?? SERVER_MESSAGE_PREFIX.find(([p]) => m.startsWith(p))?.[1];
  const key = known(message);
  if (key) return t(key);
  const field = /^[A-Za-z][\w.]*: (.+)$/.exec(message);
  if (field) return t(known(field[1]!) ?? 'e_checkForm');
  return message;
}

/** Statuses a client can see (row-level security hides drafts, items awaiting review and cancelled items). */
export const CLIENT_VISIBLE_STATUSES = ['approved', 'submitted', 'under_investigation', 'response_received', 'resolved', 'on_hold'] as const;
