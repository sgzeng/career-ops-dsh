# Questionnaire

Two parts. Fill in the answers yourself (leave the `Answer:` lines empty in the template).

- **Part A** — application-form questions (derived from `autofill.txt`, answers removed). Your answers are the source for autofilling forms.
- **Part B** — new-user survey in plain language. Each question maps to a job filter in stage 1 (automatic scan, `portals.yml`) or stage 2 (agent triage/scoring, `modes/_custom.md`, `modes/_brief.md`).

---

# Part A. Application-form answers

Answer: _(blank)_ on every line. Questions come from real forms (Workday, Greenhouse, Lever, Ashby, Comeet, amazon.jobs, Apple, IBM, ...).

## A1. Source and history
1. How did you hear about us? (default choice; special choices for referral jobs + referral code)
2. Have you previously worked for this organization?
3. Have you previously applied to / been employed by / interviewed at a given company (Amazon, Anthropic, Microsoft, PitchBook, ...)?
4. Are you currently employed by a partner or customer of the company?
5. Do you have a personal or family relationship with a current employee? (name field if yes)
6. Do you have a family/close contact who is a government official?

## A2. Identity and contact
7. Legal name; do you have a preferred name?
8. Home address (street, city, state, ZIP, country)
9. Email address to use on forms and on resumes
10. Phone number and phone type (mobile / home)
11. Current location (city, state)
12. Current company / current title (for forms that require it; may be left blank)
13. Websites: LinkedIn, GitHub, portfolio, project link, Twitter/X

## A3. Work experience (one block per job)
14. Job title
15. Company
16. Location
17. Do you currently work here?
18. From (month/year)
19. To (month/year)

## A4. Education (one block per school)
20. School / university
21. Degree
22. Field of study
23. From / To (actual or expected)
24. Graduation date (placeholder day if the form needs one)
25. Anticipated graduation date and school location (campus forms)
26. Do you intend to pursue a postgraduate degree?

## A5. Resume
27. Which resume file is the base version for this round?
28. Is the email in the resume header allowed to differ from the form email?

## A6. Work authorization and visa
29. Do you need visa sponsorship now or in the future?
30. Are you legally authorized to work in the country where the job is located without restriction?
31. Current visa type / status
32. Is sponsorship required to continue or extend your work authorization?
33. Have you held H-1B status or had a petition approved in the last 6 years?
34. Country of citizenship (export control)
35. Since obtaining your most recent citizenship, did you become a permanent resident elsewhere?
36. Are you a citizen/national/permanent resident of Iran, Cuba, North Korea or Syria?
37. If offered, are you legally eligible to begin employment immediately?
38. Right to work in UK / US (UK-based forms)
39. Jobs that require work authorization without employer sponsorship — apply or skip?

## A7. Availability, compensation, location
40. Earliest start date / availability
41. Expected base salary
42. Target total compensation for the next role
43. Salary number to type into numeric fields
44. Open to relocation? Will you self-relocate?
45. Preferred work locations, in order (first choice for location pickers)
46. Open to working in person / in the office (how many days)?
47. Do you live near a given HQ? (answer wording if not)
48. Are you subject to a non-compete or similar agreement?
49. Would you like to be considered for future opportunities / contacted about other roles?

## A8. Experience screening
50. Years of relevant non-internship professional experience (3+? 5+?)
51. Prior startup / SaaS company experience?
52. Government employee or publicly funded institution employee in the last 3–5 years?
53. Post-government employment restrictions attestation
54. Debarred / suspended from federal contracts?
55. Comfortable with the interview being recorded?
56. Background check acknowledgement
57. Which application information may the company share with similar organizations?

## A9. Platform-specific
58. Twitch: how would you describe your experience; years on the platform; creator-economy experience
59. Relocation support question (US-remote roles)
60. How did you hear (when LinkedIn is not an option)

## A10. Voluntary disclosures (EEO)
61. Gender
62. Transgender status
63. Hispanic or Latino?
64. Race / ethnic group
65. Veteran status
66. Military spouse / domestic partner? In the Reserves?
67. Disability status
68. Date and name for self-identify forms; employee ID (if applicable)

## A11. Consent, certification, terms
69. May the agent tick terms / acknowledgement / consent checkboxes for you? (the agent never submits)
70. Truthfulness certification, I-9 understanding, privacy policy, background-check, candidate confidentiality agreement — who ticks these?

---

# Part B. New-user survey (job filters)

Plain-language questions. Each one explains **why we ask**, and ends with the setting it fills (`file → key`) for whoever wires up the survey.

How the system works, in one paragraph: **Stage 1** is an automatic daily scan of company career pages and job boards. It throws away obvious mismatches using simple text rules (zero cost). **Stage 2** is an AI agent that reads each surviving job description in full, rejects deal-breakers (quoting the sentence that caused it), and scores the rest. "JD" below means the job description.

## B1. What jobs do you want? (title rules, Stage 1)
1. What job titles are you looking for? List every variant. *Why: a job is kept only if its title contains one of these.* → `title_filter.positive`
2. Which words in a title mean "definitely not for me"? *Why: removes obvious mismatches such as Sales or Recruiter.* → `title_filter.negative`
3. For each keyword, should it match anywhere, only at the start of a word, or only as a whole word? *Why: "Market" should catch "Marketing", but "PM" should not catch "pump".* → `word:` / `stem:` prefixes
4. Do you follow any very large employers (thousands of openings) where only a few job families matter to you? *Why: for these we use a tighter title list so you are not flooded.* → `title_nets`
5. Is any keyword fine for one specific company but too noisy for everyone else? → per-company `title_net`

## B2. Jobs with a vague title (JD keyword rules, Stage 1)
6. Which words, if they appear inside a JD, show the job fits you even when the title is generic? (e.g. "SQL", "forecasting", "patient care") *Why: titles like "Specialist II" hide what the job really is.* → `content_filter.positive`
7. Which of those are strong enough that one mention alone saves a job whose title did not match? → `content_rescue.thesis_words`
8. Which broader words only count when several of them appear together? (e.g. "data", "customer", "analysis") → `content_rescue` generic words
9. Which words in a JD should disqualify a rescue (company boilerplate, off-topic areas)? → `content_rescue.negative`

## B3. Seniority (Stage 1 and Stage 2)
10. What is your level today (new graduate / early career / mid-level / senior), and how many years of full-time experience do you have? *Why: sets how high above you a job may be.* → `profile.yml`
11. Which levels do you want hidden by title? (internship, entry, mid, senior …) → `skip_tiers`
12. Which title words signal a level above you? (e.g. Staff, Principal, Director, Fellow) → `level_filter.block`
13. Are there titles with those words that are actually fine? (e.g. "Member of Technical Staff") → `level_filter.exempt`
14. At how many required years of experience is a senior job too far above you? *Why: only "required" years count, not "preferred".* → `level_filter.min_years`
15. Is a job a no if you would have to manage people or lead a team? Are mentoring and leading a project fine? → level rule
16. May a senior-titled job still be kept if its JD says it accepts new graduates or people with less experience? *Why: titles inflate; the JD is what matters.* → Hard blockers
17. Are manager / director / head-of roles a no? → Hard blockers
18. If a job asks for many years but its title is not senior, should it be rejected or just ranked lower? → Hard blockers

## B4. Where can you work? (Stage 1 and Stage 2)
19. Which countries are acceptable? → `location_filter.always_allow` / `allow`
20. Which states or cities, in order of preference? *Why: preferred places score higher; they are not hard rules.* → `location_filter.allow`, `profile.yml`
21. Is a job listed only as "Remote" acceptable? If so, remote in which countries? *Why: many "Remote" jobs are limited to a country you may not be able to work in.* → `allow` / `block`
22. Which places are an automatic no? → `location_filter.block`
23. Must the posting clearly name an acceptable place, or is a vague location OK? → Hard blockers
24. Would you relocate, and to where first? → `profile.yml`

## B5. Work permission (Stage 1 and Stage 2)
25. Do you need an employer to sponsor your visa or work permit, now or later? What is your current status? *Why: the single biggest reason applications fail.* → `profile.yml → needs_sponsorship`, `visa_status`
26. Which JD phrases should make a job a no? (e.g. "no sponsorship", "citizens only", "must hold permanent residency") → `visa_filter.negative`
27. Do you want jobs that require a government security clearance, or export-control eligibility (typical for defense work), removed? → `visa_filter.negative`, Hard blockers
28. Which phrases are good signs? (e.g. "we sponsor visas") → `country_eligibility_filter.inclusive`
29. If a JD says nothing about sponsorship, keep it or drop it? → `visa_filter.require_mention`
30. May the scan download each full JD to check the above? (more accurate, slower) → `visa_filter.fetch_jd`

## B6. How old may a posting be? (Stage 1 and Stage 2)
31. What is the oldest posting you will consider? *Why: old postings are often filled or abandoned.* → `max_posting_age_days`
32. How many days back should each daily scan look? → `scan --since`
33. When you add a new company, how far back should the first scan look, to catch roles that are already open? → `first_scan_backfill.window_days`
34. After how many days does a posting need proof that it is still open? → Hard blockers
35. After how many days without a reply should an application be marked stale? → `close-stale --days`

## B7. New-graduate / entry-level channel (Stage 1)
36. Do you want new-graduate, early-career or university-graduate postings, which are often open for a year?
37. Which title words mark them? (e.g. "New Grad", "Early Career", "Graduate Program") → `campus_track.markers`
38. How far back should these look? → `campus_track.window_days`
39. Do some large employers post many graduate roles in fields you do not want? Which ones, and which fields do you accept? → `campus_track.company_nets`
40. Which graduate-type titles do you never want? (e.g. internship, co-op) → `campus_track.exclude`

## B8. Pay (Stage 1 and Stage 2)
41. What are the lowest and highest yearly pay you would consider, and in which currency? → `salary_filter`, `profile.yml → compensation`
42. Is your minimum a hard floor (job rejected) or just a reason to rank lower?
43. If a posting shows no pay, keep it or penalize it?

## B9. Where to look (Stage 1 and Stage 2)
44. Which companies do you want checked directly? (name and careers-page link) → `tracked_companies`
45. Which companies must never be scanned or applied to? → `data/blacklist.md`
46. Do you want LinkedIn job searches? Which search words, and how many days back? → LinkedIn `parser.args`
47. Do you want the scan to sweep the public job-board directories of whole hiring platforms (Greenhouse, Ashby, Lever) and startup lists (Y Combinator, a16z portfolio)? → `scan-ats-full.mjs`
48. Do you have lists of companies to add, such as sponsors of an industry conference or finalists of a competition? → `data/seeds/*.yml`
49. Which monthly job threads or boards should be read? (e.g. Hacker News "Who is hiring") → `job_boards`
50. For companies with no scannable career page, which search phrases should the agent run on a search engine? → `search_keyword_groups`, `search_queries`
51. Do you have an export of your LinkedIn connections, to spot people you know at target companies? → `data/Connections.csv`

## B10. Avoiding duplicates and fake sources
52. Which job-site domains do you trust as the genuine home of a posting? → `trust_filter.ats_allowlist`
53. Which company names are the same employer under different brands? *Why: so one job is not counted twice.* → `company_aliases`
54. After a job is dropped, how many days before it may come back? → `scan_history.recheck_after_days`

## B11. How the AI agent decides (Stage 2)
55. In one sentence, what is the kind of work you want most? *Why: the agent uses it as the yardstick for fit.* → `_custom.md` keyword spine
56. What matters most when scoring? Split 100 points across: match with your skills, seniority fit, location, type of role, company/team. → `_custom.md` Scoring Rules
57. Should some job types get bonus points (e.g. new-graduate roles), and what is the maximum score?
58. Above what score should the agent prepare a tailored resume automatically? Below what score should it skip a job quickly? → `auto_pdf_score_threshold`, `triage_threshold`
59. Below what score do you not want to apply at all?
60. Which other deal-breakers apply to you? (e.g. certain industries, on-call duty, heavy travel) → Hard blockers
61. What signals a suspicious posting? (staffing agencies, hidden employer, "ghost" jobs that never hire) → Block G legitimacy
62. Must the agent read the full JD before rejecting any job, and quote the sentence that caused the rejection? (recommended: yes) → Pipeline Rules

## B12. What the agent may do for you
63. May it tailor your resume for each job? One page only? Which design template? → `cv.template`
64. May it fill in application forms? Which questions must it never answer for you? (citizenship, pay, start date, years of experience, legal agreements)
65. Which browser profile should it use for forms and LinkedIn?
66. May it read your email? (recommended: only when you ask)
67. How do you prefer to be contacted, and what is your notice period? → `profile.yml`

## B13. What may be claimed about you
68. Which file is the single source of truth about your experience (your master resume), and which folder of papers or projects may be used to double-check facts? → `cv.md`
69. Which projects did you build yourself, and which did you only use? *Why: the agent never claims authorship you did not state.*
70. Which achievements may be quoted with numbers, and where is each number written down?

---

# Form-handling rules (not answers)

- Never press Enter on an application page; pick dropdown options by clicking; never click Submit/Apply/Send. You submit.
- Install an Enter-key guard on the page before touching a form.
- Use find refs, not pixel coordinates (banners shift the page).
- Chrome autofill and resume parsing can pre-fill or overwrite fields: re-check every field after uploading a resume.
- Greenhouse: react-select dropdowns — click the field, type, then click the option.
- Workday: real keystrokes; the Terms checkbox blocks saving the Disclosures step; a second application to the same req is refused.
- Lever: set values with the native setter plus input events; the resume upload overwrites phone, current company and links.
- Ashby: may reject automated submissions as spam; date pickers do not take free text.
- Comeet: the form is inside an iframe — open the iframe URL as a top-level tab.
- Cloudflare Turnstile / reCAPTCHA / sign-in / verification codes are always yours.
- Google Careers: at most 3 applications per 30 days.
