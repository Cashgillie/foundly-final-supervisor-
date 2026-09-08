/* ============================================================
   FOUNDLY — EmailJS configuration
   ------------------------------------------------------------
   Used to notify a report's owner by email when an admin marks
   their report "Resolved" (e.g. after matching a Found item to
   their Lost report).

   EmailJS runs entirely client-side — no server or secret key
   needed, which fits this project's "no backend infra" setup.

   Setup (free):
   1. Create an account at https://www.emailjs.com
   2. Add an Email Service (e.g. connect your Gmail) — copy its Service ID
   3. Create an Email Template with variables: {{to_email}}, {{item_title}},
      {{item_type}}, {{item_category}}, {{item_location}} — copy its Template ID
   4. Account > General > copy your Public Key
   5. Paste all three values below

   
   ============================================================ */

export const EMAILJS_SERVICE_ID = "service_fdwnpcs";
export const EMAILJS_TEMPLATE_ID = "template_1bdw16b";
export const EMAILJS_PUBLIC_KEY = "GGsoD7lxOOzLXdB5c";


export const EMAILJS_LOST_REPORT_TEMPLATE_ID = "template_t7f8jnf";
