// lib/level-filter.mjs — drop a posting above the candidate's level ceiling,
// judged on the JD text, never on the title alone.
//
// Fork-local. The rule (portals.yml → level_filter) is a conjunction:
//
//   title carries a `block` word (Staff / Principal / Distinguished)
//   AND the JD requires `min_years`+ years of experience, or makes leading a
//       team (the team's tech lead, or a people manager) part of the job
//   → drop.
//
// A Staff-titled posting whose JD asks for fewer years and no team leadership
// is kept: plenty of "Staff" reqs are senior-IC seats. When there is no JD text
// to read (the ATS listing carries none and no detail fetch worked), the
// posting is kept with a note so stage 2 reads the JD instead. Every doubtful
// case keeps the posting: a wrong keep costs one stage-2 read, a wrong drop
// loses the job for good.
//
// Title: `block` words match as whole words after every `exempt` phrase is
// blanked ("Member of Technical Staff" is a flat title). A multi-level req that
// includes Senior ("Senior/Staff", "Senior/Lead/Principal") is never gated —
// its Senior half may fit.
//
// JD evidence is judged where it sits, not per sentence: ATS text often arrives
// with its bullets flattened onto one line, so sentence boundaries are
// unreliable. Each "N years" figure and each lead phrase is checked for
//   - section: under a Preferred / Nice to have / "Strong candidates may also"
//     / "What sets you apart" heading, or in Benefits / About us boilerplate →
//     ignored (the rule is about what the job requires);
//   - its own clause: "(preferred)", "is a plus", "helpful but not required"
//     → ignored;
//   - what the figure measures: only experience counts — not age, residency,
//     company history, vesting, retention, roadmaps ("the next 10 years");
//   - alternatives: "8 yrs with a BS; 6 with an MS; or 4 with a PhD", "(5+ with
//     a PhD)", "Senior (6+ yrs) or Staff (9+ yrs)" count at the lowest figure;
//     "PhD / a degree, or 8+ years" waives it; "a PhD may substitute for up to
//     4 years" subtracts;
//   - whose duty a lead phrase describes: the posting's own role only — not
//     "your people manager", "a direct report to the CISO", "partner with each
//     team's tech lead", "who leads a 12-person team"; negated phrases and any
//     JD that declares an individual-contributor role never count as lead.
//
// portals.yml:
//   level_filter:
//     enabled: true
//     block: ["staff", "principal", "distinguished"]
//     exempt: ["member of technical staff"]
//     min_years: 8          # default 8
//     fetch_jd: true        # default true: fetch the JD for a gated title whose listing has none

import { compileKeyword } from '../title-keywords.mjs';

export const DEFAULT_MIN_YEARS = 8;
// Below this many characters a description is a teaser, not a JD.
export const MIN_JD_CHARS = 400;

function normalizeList(value) {
  if (value == null) return [];
  return (Array.isArray(value) ? value : [value])
    .filter((s) => typeof s === 'string')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

// "Senior/Staff", "Sr. / Principal", "Senior/Lead/Principal", "Staff/Senior",
// "Senior or Staff", "Senior & Principal".
const LEVEL_JOIN = '\\s*(?:\\/|&|\\bor\\b|\\band\\b)\\s*';
// "Staff / Senior Staff" has no Senior half: a Senior that is itself followed
// by Staff / Principal is part of a higher level.
const SENIOR_ALONE = '(?:senior|sr\\.?)(?!\\s+(?:staff|principal|distinguished)\\b)';
const MULTI_LEVEL_WITH_SENIOR_RE = new RegExp(
  `\\b${SENIOR_ALONE}${LEVEL_JOIN}(?:[a-z.]+${LEVEL_JOIN})*(?:staff|principal|distinguished)\\b`
  + `|\\b(?:staff|principal|distinguished)${LEVEL_JOIN}(?:[a-z.]+${LEVEL_JOIN})*${SENIOR_ALONE}\\b`,
);

const WORD_NUMBERS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
};
const NUM = `(?:\\d{1,2}|${Object.keys(WORD_NUMBERS).join('|')})`;
// "8+ years", "8 years", "8-10 years", "8 to 10 yrs", "eight (8) years",
// "8 or more years", "between 5 and 8 years", "eight-plus years", "8+ yoe",
// "10 (ten) years".
// Group 1 = "between" lower bound, group 2 = the figure, group 3 = the unit.
const YEARS_RE = new RegExp(
  `\\b(?:between\\s+(${NUM})\\s+(?:and|to)\\s+)?(${NUM})(?:\\s*\\((?:${NUM})\\+?\\))?(?:\\s*(?:-|to)\\s*${NUM})?\\s*(?:\\+|-?\\s*plus)?\\s*(?:or more\\s+|or greater\\s+)?(years?|yrs?|yoe)\\b'?`,
  'g',
);
// Label-first form from ATS key/value fields: "Minimum Years of Experience: 10+"
// (never "Preferred Years of Experience").
const LABEL_FIGURE_RE = new RegExp(`\\b(?:years? of (?:relevant |professional |work |industry |related )?experience|experience \\(years?\\)|yrs? of exp(?:erience)?)(?: required)?\\s*[:=-]\\s*(?:a minimum of |minimum of |minimum |min |at least )?(${NUM})\\s*\\+?`, 'g');
// A figure preceded by one of these is a time span, not a requirement:
// "the last ten years", "over the next 10 years", "after 8 years of service".
const TIME_WORD_BEFORE_RE = /\b(?:the|last|past|next|previous|recent|every|after|within|first|following|coming|those|these)\s*$/;
// A figure followed by one of these measures something other than experience.
const NOT_EXPERIENCE_AFTER_RE = /^\s*'?\s*(?:of age|old|ago|later|from now|away|back|prior|of (?:service|employment|tenure|history|operation|operations|data|logs|retention|residency|residence|citizenship|vesting|runway|uptime|growth|consecutive|combined|collective)|combined|collective|to (?:exercise|vest)|in (?:business|operation|production|service|the field|market))\b/;
// What ties a figure to experience. Either "N years [adj ...] experience"…
const EXPERIENCE_NOUN_AFTER_RE = /^\s*'?s?\s*(?:[a-z/&-]+\s+){0,4}?(?:experience|expertise|track record|career|background(?! (?:check|investigation|screening)))\b/;
// …or a requirement-style continuation: "8+ years building", "10+ years in
// security engineering", "15 years of professional software development".
const EXPERIENCE_VERB_AFTER_RE = /^\s*(?:building|developing|designing|writing|shipping|leading|managing|running|operating|doing|delivering|conducting|securing|working (?:in|on|with|as)|hands[- ]on|professional|industry|relevant|related|progressive|practical|post-?(?:graduate|doctoral|phd))\b/;
const EXPERIENCE_PREP_AFTER_RE = /^\s*(?:(?:of|at|on|with)\b[^.;!?\n]{0,90}?\b(?:experience|experienced|expertise|mastery|track record|industry|professional|career|hands[- ]on|researcher|engineer|developer|analyst|scientist|consultant|role|roles|position|building|developing|designing|conducting|leading|managing|writing|shipping|working|doing|delivering)|(?:in|as|across|within)\b[^.;!?\n]{0,90}?\b(?:experience|expertise|industry|professional|career|hands[- ]on|engineering|security|cybersecurity|infosec|appsec|software|development|research|researcher|engineer|developer|analyst|scientist|consulting|role|roles|position|machine learning|ml|ai|systems|infrastructure|networking|cryptography))\b/;
// Label form only: "Experience: 8+ years", "Exp: 10+ yrs", "experience of 10 years".
const EXPERIENCE_BEFORE_RE = /\b(?:experience|yoe|exp)\b(?:\s+required|\s+level)?\s*(?::|-|of)\s*(?:a minimum of|minimum of|minimum|min|at least|over)?\s*$/;
// The candidate as subject of a duration: "you've shipped … code for more than 10 years".
const YOU_FOR_BEFORE_RE = /\byou(?:'ve| have| bring)?\b[^.;!?\n]{0,90}\bfor\s+(?:over\s+|more than\s+|at least\s+|the past\s+)?$/;
// Product lifetimes and retention periods: "stay in service for 15+ years".
const NOT_EXPERIENCE_BEFORE_RE = /\b(?:in service|in production|in operation|lifetime|lifespan|warranty|retain\w*|stor(?:e|ed|es|ing)|archiv\w*|support(?:ed)? for|holds?|holding|contains?|keeps?|spans?|spanning|covering|worth|(?:has |have |been )?(?:run|ran|running|operat\w*|existed|lived|served|serving|grown|growing)(?: for)?|avg|average|median|mean)\b[^.;!?\n]{0,20}$/;
// Company history, not a requirement: "for over 10 years we have...".
const COMPANY_HISTORY_RE = /\b(?:founded|history|in business|we(?:'ve| have) been|our (?:company|mission)|has grown)\b/;
const YOU_RE = /\b(?:you|your|candidate|applicant|required|requirements?|must|qualifications?)\b/;

const DEGREE = '(?:bachelor|master|phd|doctorate|doctoral|advanced|graduate|post-?graduate|ms|bs|ba|ma|msc|bsc|mba|meng|beng)';
const LEVEL = '(?:senior|sr|staff|principal|lead|mid(?:-level)?|junior|entry(?:-level)?|l\\d|e\\d|ic\\d)';
// The text between two figures that makes the second an alternative to the
// first: ", or 13 years", "; MS with 6+ years", " OR Master's Degree in … AND 6+
// years", ") or Staff (9+ years".
const ALTERNATIVE_TAIL_RE = new RegExp(
  `(?:(?:^|[\\s,;(])or\\s+(?:an?\\s+|at least\\s+|a minimum of\\s+)?$`
  + `|(?:;\\s*|\\bor\\s+(?:[-*•]\\s*)?)(?:an?\\s+|the\\s+)?${DEGREE}\\S*\\s+(?:(?:degree|in)\\s+)?(?:[a-z'/&,.-]+\\s+){0,10}?(?:and|with|plus|\\+|&)\\s+(?:an?\\s+(?:additional\\s+)?|at least\\s+|a minimum of\\s+)?$`
  + `|,\\s*(?:an?\\s+)?${DEGREE}\\S*\\s+(?:(?:degree|in)\\s+)?(?:[a-z'/&.-]+\\s+){0,8}?with\\s+(?:an?\\s+(?:additional\\s+)?|at least\\s+)?$`
  + `|\\bor\\s+${LEVEL}\\S*\\s*(?:level\\s*)?[(:-]?\\s*$)`,
);
// "(5+ with a PhD)", "or 4 years with a Ph.D." right after a figure.
const DEGREE_FIGURE_AFTER_RE = new RegExp(
  `[(,;]\\s*(?:or\\s+)?(${NUM})\\s*\\+?\\s*(?:years?|yrs?)?\\s*(?:with|given|for candidates with|if you have)\\s+(?:an?\\s+|the\\s+)?(?:relevant\\s+|related\\s+)?(?:phd|doctorate|doctoral|master'?s?(?: degree)?|ms(?= degree|\\s*\\)|,|;|$)|advanced degree|graduate degree)\\b`,
  'g',
);
// "8 (BS) / 6 (MS) / 4 (PhD)": a degree-tagged ladder in one clause.
const DEGREE_TAG_AFTER_RE = new RegExp(
  `^[^.!?\\n]{0,80}?(${NUM})\\s*\\+?\\s*(?:years?|yrs?)?\\s*\\(\\s*(?:phd|doctorate|doctoral)\\s*\\)`,
);
// "a PhD may substitute for up to 4 years of this experience"
const SUBSTITUTION_AFTER_RE = new RegExp(
  `^[^!?\\n]{0,250}?\\b(?:phd|doctorate|doctoral|advanced degree|graduate degree|master'?s(?: degree)?)\\b[^.!?\\n]{0,60}?\\b(?:(?:may|can|will|could)\\s+(?:be\\s+)?(?:substitute[sd]?|count(?:ed)?|considered|applied)|counts?|is equivalent|equals)\\s+(?:for|toward|towards|as|to)?\\s*(?:up to\\s+)?(?:(${NUM})\\s+(?:years?|yrs?)|some|part|a portion|the|this|experience)`,
);
// "PhD, or 8+ years", "a degree … or at least 8 years": the degree path suffices.
const DEGREE_OR_BEFORE_RE = /\b(?:phd|doctorate|doctoral|degree|bachelor'?s?|master'?s?|bs|ms|ba|msc|bsc)\b[^.!?\n]{0,200}?(?:,\s*|\s)or\s+(?:an?\s+|at least\s+|a minimum of\s+|equivalently\s+)?$/;
// "8+ years of industry experience or a PhD"; also an "OR" on its own bullet.
// Not "ideally with an MS or PhD" (a degree added to the years) and not "in
// industry or during a PhD" (PhD years counting toward the figure).
const DEGREE_OR_AFTER_RE = /^([^.!?\n]{0,100}?)\bor\s+(?:an?\s+|the\s+)?(?:(?:relevant|related|equivalent|completed|advanced)\s+)?(?:phd|doctorate|doctoral|master'?s|graduate degree|advanced degree)\b/;
// "PhD, or Master's degree and 10+ years": the PhD alone qualifies.
const PHD_ALONE_BEFORE_RE = /\b(?:phd|doctorate|doctoral(?: degree)?)(?:\s+(?:degree|in\s+[a-z ,&\/-]{0,60}?))?\s*,?\s+or\s+(?:an?\s+)?(?:master|bachelor|ms\b|bs\b|ba\b|msc|bsc|mba)/;
const DEGREE_OR_BULLET_AFTER_RE = /^[^.!?]{0,200}?(?:\n|•| - )\s*(?:[-*•]\s*)?or\s*(?::|\n|•| - )\s*(?:[-*•]\s*)?(?:an?\s+)?(?:phd|doctorate|doctoral|master'?s|graduate degree|advanced degree)\b/;

// Preference wording attached to the evidence itself. Kept tight: in flattened
// text the previous bullet's "ideally Splunk" or the next one's "B.S.
// preferred" must not leak onto a real requirement.
const PREFERENCE_BEFORE_RE = /\b(?:ideally|preferably|bonus|nice[- ]to[- ]have|a plus)\s*[:,-]?\s*(?:(?:you|you'll|you will)\s+(?:have|bring)\s+)?(?:at least\s+|over\s+|a minimum of\s+)?$/;
const PREFERENCE_AFTER_RE = /^(?:\s*[^.;!?\n•]{0,30}?\bpreferred\b(?! qualifications| skills| experience| requirements| background)|[^.;!?\n•]{0,60}?\(\s*(?:strongly\s+|highly\s+)?(?:preferred|a plus|nice to have|bonus|desired|ideal|optional)\s*\)|[^.;!?\n•]{0,160}?\b(?:is|are|would be|will be|as)\s+(?:strongly\s+|highly\s+|a\s+)?(?:big\s+|huge\s+|strong\s+|definite\s+)?(?:preferred|a plus|plus|helpful|desirable|advantageous|nice to have|a bonus|bonus|welcome|an advantage|advantage)\b|[^.;!?\n•]{0,160}?\b(?:helpful|nice|useful|welcome)(?:,)?\s+but not required\b)/;
// When the requirement has its own verb ("You bring 10+ years …, and X is a plus"),
// a later "is a plus" belongs to the next conjunct, not to the figure.
const PREFERENCE_AFTER_STRICT_RE = /^(?:\s*[^.;!?\n•]{0,30}?\bpreferred\b(?! qualifications| skills| experience| requirements| background)|[^.;!?\n•]{0,60}?\(\s*(?:strongly\s+|highly\s+)?(?:preferred|a plus|nice to have|bonus|desired|ideal|optional)\s*\)|(?:(?!,\s*(?:and|or|plus)\b)[^.;!?\n•]){0,160}?\b(?:is|are|would be|will be|as)\s+(?:strongly\s+|highly\s+|a\s+)?(?:big\s+|huge\s+|strong\s+|definite\s+)?(?:preferred|a plus|plus|helpful|desirable|advantageous|nice to have|a bonus|bonus|welcome|an advantage|advantage)\b|[^.;!?\n•]{0,160}?\b(?:helpful|nice|useful|welcome)(?:,)?\s+but not required\b)/;
// Negated lead duty: "no people-management responsibilities", "you won't have direct reports".
const NEGATION_BEFORE_RE = /\b(?:no|not|none of|without|never|isn't|won't|wont|don't|doesn't|will not|do not|does not|zero|nor|rather than|instead of)\s+(?:[a-z'-]+\s+){0,3}$/;
// An optional future path, not a duty: "if you choose to later on, become a people manager".
const FUTURE_BEFORE_RE = /\b(?:if you (?:choose|want|wish|decide)|choose to|later on|eventually|career paths?|grow into|option to|opportunity to|could|might|may)\b[^.;!?\n]{0,50}$/;
// A JD that says the seat is an IC one never counts a lead phrase.
const IC_DECLARATION_RE = /\b(?:individual[- ]contributor (?:role|position|seat|track|ladder)|(?:an?|this is an?) individual[- ]contributor\b|ic (?:role|position|track|career ladder)|no (?:formal )?(?:people[- ]management|direct reports|management responsibilit)|not a (?:people[- ])?manag(?:er|ement) (?:role|position)|won't have direct reports|without direct reports)/;

// Headings. `ignore` starts a Preferred-type span whose figures and lead
// phrases don't count, until a `count` heading. `boiler` starts a company-
// boilerplate span (About us, Benefits, EEO) that also doesn't count, but ends
// sooner — at any requirements-ish word (`softend`), or after BOILER_SPAN
// chars — because a flattened JD may have no clear heading after "About us".
// Single generic words only count as headings in heading form — followed by a
// colon, or alone on a line — so "PCI DSS requirements" in a bullet does not
// end a Preferred span.
const BOILER_SPAN = 700;
const HEADINGS = [
  { kind: 'ignore', re: /\b(?:preferred\s+(?:[a-z&]+\s+){0,4}?(?:qualifications|skills|experience|expertise|requirements|background)|desired (?:qualifications|skills|experience)|desirable (?:criteria|qualifications|skills|experience|requirements)|nice[- ]to[- ]haves?(?:\s+(?:requirements|qualifications|skills|experience))?|bonus (?:qualifications|skills|experience)|bonus points|bonus if you|pluses|what (?:would|will) make you stand out|you(?:'ll| will) stand out if|ways to stand out|what sets you apart|great to have|good to have|it would be great if|it'?s a plus if|even better if|extra credit|strong candidates (?:may|might|will) also|you might also have|ideal candidates (?:may|will) also|(?:the following )?would be (?:an advantage|advantageous|a plus|beneficial|nice to have))\b/g },
  { kind: 'ignore', re: /(?<!\(\s?)\b(?:preferred|bonus|nice to have|desirable|desired)\s*:(?![^()\n]{0,40}\))/g },
  { kind: 'ignore', re: /(?:^|\n)\s*(?:[-*#•]\s*)?(?:preferred|bonus|nice to have)\s*(?:\n|$)/g },
  // A short line of its own (not a bullet) naming a preference / requirement
  // section: "Desirable", "Bonus experience", "Must haves".
  { kind: 'ignore', re: /(?:^|\n)(?![-*•])[^\n]{0,30}\b(?:preferred|bonus|desirable|desired|nice[- ]to[- ]haves?|pluses|advantage(?:ous)?|stand out|extra credit)\b[^\n.]{0,30}(?=\n)/g },
  { kind: 'count', re: /(?:^|\n)(?![-*•])[^\n]{0,30}\b(?:requirements|qualifications|responsibilities|must[- ]haves?|what you(?:'ll| will) (?:need|bring|do)|about you|who you are|essential)\b[^\n.]{0,30}(?=\n)/g },
  { kind: 'boiler', re: /\b(?:about us|about the company|who we are|our story|what we offer|our offer|equal (?:employment )?opportunity|pay transparency)\b/g },
  { kind: 'boiler', re: /\b(?:benefits|perks|compensation|pay range|salary range|base salary)\s*:/g },
  { kind: 'boiler', re: /(?:^|\n)\s*(?:[-*#•]\s*)?(?:benefits|perks|compensation)\s*(?:\n|$)/g },
  { kind: 'softend', re: /\b(?:requirements|qualifications|responsibilities|the role|this role|what you(?:'ll| will) (?:do|need|bring)|in this role|about the (?:role|job|team|position)|we(?:'re| are) (?:hiring|looking for|seeking)|you(?:'ll| will) (?:lead|own|build|manage|be responsible))\b/g },
  { kind: 'count', re: /\b(?:minimum qualifications|basic qualifications|minimum requirements|basic requirements|must[- ]haves?|required\s+(?:[a-z&]+\s+){0,4}?(?:qualifications|skills|expertise)|essential (?:criteria|requirements|qualifications|skills)|you may be a good fit if|what you(?:'ll| will) need|what we(?:'re| are) looking for|what you(?:'ll)? bring|what we need to see|what you need to succeed|what you(?:'ll| will) (?:be )?do(?:ing)?|in this role,? you(?:'ll| will)|about the (?:job|role|position)|key qualifications|key responsibilities)\b/g },
  { kind: 'count', re: /\b(?:requirements|qualifications|responsibilities|required|essential|the role|you have|you are|you will|who you are|about you|in this role|about the team|your impact|your role|role overview|day[- ]to[- ]day|the opportunity|duties)\s*:/g },
  { kind: 'count', re: /(?:^|\n)\s*(?:[-*#•]\s*)?(?:requirements|qualifications|responsibilities|the role|who you are|about you|in this role|about the team|your impact|your role|role overview|day[- ]to[- ]day|the opportunity|duties)\s*(?:\n|$)/g },
];

// Leading a team — as the posting's own duty or requirement. `pre` rejects a
// match by the text just before it (someone else's team, help / participate);
// `people` marks people-management phrasing, which a declared IC seat rules out.
const OTHERS_BEFORE_RE = /\b(?:partner(?:ing)?|work(?:ing)?|collaborat\w*|coordinat\w*|together|alongside|support\w*|report\w*|liaise|liaising|sync|align\w*|meet\w*|interfac\w*)\s+(?:closely\s+)?(?:with|to)\b[^.;!?\n]{0,40}$|\b(?:your|our|their|each|every|other|product)\s+(?:[a-z-]+\s+)?(?:team'?s?\s+)?$|'s\s+$/;
// Text before an "as … manager/lead" phrase that makes someone else its subject:
// "as well as", "our head of detection, who also acts as", "led by", "reports
// to". "We're hiring a Staff engineer who will serve as" is the candidate.
const SUBJECT_ELSEWHERE_RE = {
  test(before) {
    if (/\b(?:well|such)\s+$|\b(?:led by|managed by|run by|report(?:s|ing)?(?: in)? to|with)\s+(?:a |an |the |our |your )?$/.test(before)) return true;
    if (!/\b(?:who|which|that|he|she|they)\b[^.;!?\n]{0,25}$/.test(before)) return false;
    return !/\b(?:hiring|looking for|seeking|searching for|need|want|recruiting)\s+(?:a|an|our)\s+[^.;!?\n]{0,60}\bwho\b[^.;!?\n]{0,25}$/.test(before);
  },
};
const LEAD_PATTERNS = [
  // "lead a team of engineers", "manage the security team", "build and lead a
  // high-performing team". Up to three words between verb and "team", none a
  // preposition; not cross-team / red team / scrum team; not the team's
  // (possessive) priorities or programs.
  {
    re: /\b(?:lead|leading|manage|managing|oversee|overseeing|supervise|supervising|line[- ]manage|line[- ]managing|build and lead|building and leading|grow and lead|growing and leading|hire and lead|hire and manage|build and manage|building and managing)\s+((?:[a-z0-9&'\/-]+\s+){0,5}?)(?<!cross[- ]|scrum |agile )(teams?|group of (?:engineers|researchers|developers)|squad)\b(?![;\/]|\s*'|\s*(?:-|to\s+)?(?:priorities|goals|objectives|calendars?|meetings?|culture|rituals|ceremonies|processes|tools|tooling|efforts|initiatives|projects|workstreams|programs?|operations|engagements|exercises|assessments|campaigns|activities|testing|work|findings|reports|reviews|adversary|emulation|simulations?|ops|tradecraft|infrastructure|sessions|channels?|meetings|configuration|members'?\s+(?:on|in|across))\b)/g,
    // Plural "teams" led across a product org ("lead product teams through
    // threat modeling") is influence, not leading one's own team.
    // Plural "teams" counts only bare or counted ("leading teams", "manage two
    // teams"): "lead platform teams through …" is influence over other teams.
    // A red / purple / blue team is an activity unless the role manages it as
    // a group of people ("manage our internal red team of five operators").
    guard: (between, object, verb, after) => !/\b(?:across|with|for|to|of|on|in|from|between|among|alongside|within|by|and|or|other|microsoft|when|while|if|whenever|because|so|through|during|after|before|as|needs?|that|which|who)\b/.test(between)
      && (between.trim().split(/\s+/).length <= 3 || /^(?:the|our|your|a|an|this)\s/.test(between))
      && !(object === 'teams' && !/^(?:(?:two|three|four|five|several|multiple|\d+)\s+(?:[a-z-]+\s+)?)?$/.test(between))
      && !(/\b(?:red|blue|purple|tiger)\s*-?\s*$/.test(between) && !(/^(?:manage|managing|supervise|supervising|oversee|overseeing|build and|building and)/.test(verb) && /^\s+of\b/.test(after))),
    pre: /\b(?:who|which|that|help|helps|helping|support|supporting|assist|assisting|participate in|contribute to|industry's|world's|the|each|every|embed(?:ded)? with)\s+$/,
    // "leading teams in a technical capacity or leading technical risk
    // analysis": leading a team is one option, not the requirement.
    alternative: /^[^.;!?]{0,60}?\bor\s+(?:leading|driving|owning|running|managing\s+(?:projects|programs|initiatives))\b/,
  },
  // "have led security teams", "experience having managed a team"
  {
    re: /\b(?:you have|you've|you have previously|have previously|having|experience having|track record of having)\s+(?:successfully\s+)?(?:led|managed|supervised|built and led|built and managed)\s+(?:a |an |the |your )?(?:[a-z-]+\s+){0,2}?(?:teams?|engineers|researchers)\b/g,
    pre: /\b(?:founders?|ceo|cto|ciso|cso|vp|director|head|leaders?|leadership|managers?|we|who|they|she|he)\s+(?:also\s+|previously\s+)?$/,
  },
  // "manage 5 engineers", "supervise a group of researchers"
  {
    re: /\b(?:manage|managing|supervise|supervising|oversee|overseeing|line[- ]manage|line[- ]managing)\s+(?:a |an |the |your |our )?(?:(?:small|large|growing|\d+\s*(?:-|to)\s*\d+|\d+\+?|two|three|four|five|six|seven|eight|nine|ten|several|multiple|first few|first|few|a handful of|handful of)\s+)?(?:team of |group of )?((?:[a-z\/&-]+\s+){0,2}?)(?:engineers|researchers|analysts|developers|employees|direct reports|staff members|scientists|(?:engineering|people|first-line|line|other) managers)\b/g,
    guard: (between) => !/\b(?:across|with|for|to|of|on|in|from|between|among|alongside|within|by|and|or|access|accounts|identities|credentials|secrets|permissions)\b/.test(between),
    pre: /\b(?:help|helps|helping|support|supporting|assist|assisting)\s+$|\b(?:partner|work|collaborat\w*)\s+with\s+$/,
    people: true,
  },
  // Third person, with this role as subject: "The Principal Cybersecurity
  // Engineer leads a team of six", "this role manages four engineers".
  { re: /\b(?:this (?:role|position|person|engineer|hire)|the (?:incumbent|successful candidate|(?:senior staff|staff|principal|distinguished)\b[a-z ,&-]{0,50}?\b(?:engineer|researcher|architect|scientist)))\s+(?:also\s+|directly\s+)?(?:leads|manages|supervises|oversees)\s+(?:a |the |an )?(?:[a-z0-9&'\/-]+\s+){0,4}?(?:team|group|engineers|researchers|developers|analysts)\b/g },
  // "lead 4 engineers and 2 applied scientists", "manage 3-5 engineers"
  { re: /\blead(?:ing)?\s+(?:a (?:group|team) of\s+)?(?:\d+(?:\s*(?:-|to)\s*\d+)?|two|three|four|five|six|seven|eight|nine|ten)\s+(?:[a-z-]+\s+)?(?:engineers|researchers|scientists|developers|analysts)\b/g, pre: OTHERS_BEFORE_RE },
  // "lead, mentor, and grow a team of five"
  { re: /\b(?:lead|build|grow),\s+(?:[a-z]+,?\s+){0,2}(?:and\s+)?(?:grow|mentor|develop|manage|scale|lead)\s+(?:a|the|your|our)\s+(?:[a-z-]+\s+){0,2}?team\b/g },
  // "the lead engineer on the Fraud Platform team", "you are the engineering lead for …"
  { re: /\b(?:as|be|are|you(?:'ll| will) be|serve as)\s+the\s+(?:lead|engineering lead|technical lead|tech lead|team lead)\s+(?:engineer\s+|researcher\s+)?(?:on|for|of)\s+(?:the|our|your)\s+[^.;!?\n]{0,50}?\bteam\b/g, pre: SUBJECT_ELSEWHERE_RE },
  // "2+ years experience managing software development teams"
  {
    re: /\byears?(?: of)?(?: experience)?\s+(?:managing|leading|supervising)\s+(?:[a-z-]+\s+){0,3}?(?:teams|engineers|people|researchers|developers)\b/g,
    alternative: /^[^.;!?]{0,60}?\bor\s+(?:leading|driving|owning|running|managing\s+(?:projects|programs|initiatives))\b/,
    people: true,
  },
  { re: /\b(?:supervision|supervisory|team leadership|people leadership)(?:\s*\/\s*(?:team|people) leadership)? (?:role|position|experience|responsibilit(?:y|ies))\b(?!\s*:\s*(?:0|none|n\/a|no)\b)/g, people: true },
  // "four engineers reporting to you"
  { re: /\b(?:engineers|researchers|analysts|reports|developers)\s+(?:who\s+(?:will\s+)?)?report(?:ing)?\s+(?:directly\s+)?(?:in\s+)?to you\b/g, people: true },
  // People management described by what it involves: the growth and
  // performance OF PEOPLE, performance reviews, 1:1s together with reviews.
  { re: /\bresponsible for the (?:growth|performance|career (?:growth|development))(?: and (?:growth|performance|development))? of (?:the |your |a )?(?:[a-z-]+ ){0,2}?(?:engineers|researchers|team members|reports|people)\b/g, people: true },
  { re: /\b(?:conduct|conducting|write|writing|deliver|delivering|own|owning|run|running)\s+(?:their\s+|team\s+|annual\s+)?performance reviews\b/g, people: true },
  { re: /\b(?:1:1s|one-on-ones|1-on-1s)\b[^.;!?\n]{0,80}\b(?:performance|year-end|annual) (?:reviews|management|evaluations)\b/g, people: true },
  { re: /\b(?:complete|completes|completing|write|writes|writing|conduct|conducts|conducting)\s+(?:annual\s+|their\s+)?performance evaluations\b/g, people: true },
  // Requirement-shaped management experience: "2+ years of engineering
  // management experience", "people management responsibilities".
  { re: /\b(?:engineering|people|line|team)[- ]management (?:experience|responsibilit(?:y|ies)|skills|role|duties)\b|\bexperience (?:in|with) (?:engineering|people|line) management\b|\byears? of (?:engineering|people|line) management\b/g, pre: OTHERS_BEFORE_RE, people: true },
  { re: /\bpeople[- ]leadership (?:experience|responsibilit(?:y|ies)|role|skills)\b|\bexperience (?:in|with) people[- ]leadership\b/g, people: true },
  { re: /\b(?:as|be|become)\s+(?:a |an |the )?people[- ](?:manager|leader)\b/g, people: true },
  { re: /\b(?:have|has|with|manage|managing|lead|leading|[1-9]\d?(?:\s*(?:-|to)\s*\d+)?|several|multiple|a few)\s+(?:[1-9]\d?\s+)?direct reports\b(?!\s+to\b)|\b(?:with|of|for) your direct reports\b/g, people: true },
  // "hire, develop and retain a team of engineers"
  {
    re: /\b(?:hire|hiring|recruit|recruiting),?\s+(?:and\s+)?(?:develop|developing|grow|growing|build|building|lead|leading|manage|managing)\b(?:,?\s+(?:and\s+)?[a-z]+){0,2}\s+(?:a|an|the|your)\s+(?:[a-z-]+\s+){0,2}?team\b/g,
    pre: /\b(?:participate in|participating in|contribute to|contributing to|help with|helping with|help us with|assist with|assisting with|assist in|support|take part in|taking part in|be involved in|join|joining|play a part in|play a role in)\s+$/,
    people: true,
  },
  // the candidate AS the tech lead / manager: "serve as the team's tech lead",
  // "act as a senior technical leader for the team"
  {
    re: /\b(?:as|serve as|serving as|act as|acting as|be|become|you(?:'ll| will) be|role of|position as|operate as)\s+(?:the |a |an |our )?(?:[a-z'-]+ ){0,2}?['"]?(?:tech(?:nical)?|team|engineering|research) (?:lead|manager)\b(?!\s+(?:on|for|of)\s+(?:(?!team\b)[^.;!?\n]){0,60}?\b(?:initiatives?|projects?|efforts?|programs?|workstreams?|engagements?|migrations?)\b)(?!\s+with\b|\s+(?:to|for|on)\s+(?:our\s+|the\s+|key\s+|enterprise\s+|strategic\s+)?(?:customers?|clients?|partners?|accounts?|stakeholders?|executives?|cisos?)\b)(?!\s*(?:,\s*)?or\s+(?:an?\s+)?(?:senior|staff|staff-level|principal|lead|ic|individual contributor|experienced|strong)\b)/g,
    pre: SUBJECT_ELSEWHERE_RE,
  },
  // "You'll be the TL for …", "This is a TLM role" (not "TL;DR", not "led by a TLM")
  {
    re: /\b(?:you(?:'ll| will) be the|serve as the|act as the|as the|this is a|is a)\s+(?:tl|tlm|tech lead manager|tech lead\/manager)\b(?![;\/]|\s*(?:of|for|on)\s+(?:other|each|every|partner))/g,
    pre: SUBJECT_ELSEWHERE_RE,
  },
  {
    re: /\b(?:as|serve as|serving as|act as|acting as|be|become|you(?:'ll| will) be|operate as)\s+(?:the |a |an |our )?(?:[a-z-]+ ){0,2}?(?:tech(?:nical)?|team|engineering) leader\b[^.;!?\n]{0,60}?\b(?:for|of|on|to|within) (?:the|your|our|a|an|this) [^.;!?\n]{0,50}?\bteam\b/g,
    pre: SUBJECT_ELSEWHERE_RE,
  },
  // "tech lead for the fuzzing team" — not "technical lead on cross-org initiatives".
  { re: /\b(?:tech(?:nical)?|team) lead (?:for|of|on)\b(?![^.;!?\n]{0,60}\b(?:initiatives?|projects?|efforts?|programs?|workstreams?|engagements?|migrations?|launch(?:es)?)\b)/g, pre: OTHERS_BEFORE_RE },
  // "a technical leadership or tech lead role"
  { re: /\b(?:tech(?:nical)? lead|team lead) (?:role|position|responsibilit(?:y|ies))\b/g, pre: OTHERS_BEFORE_RE },
  // "provide technical leadership and mentor engineers on your team"
  { re: /\bprovid(?:e|es|ing) (?:strong |hands-on |day-to-day )?technical (?:leadership|direction)\b[^.;!?\n]{0,60}?\b(?:on|to|for|within) (?:(?:your|our) (?:[a-z-]+ )?team|the team|a team of)\b/g },
  { re: /\b(?:lead|leading) and (?:mentor|mentoring|grow|growing|develop|developing|manage|managing)\s+(?:a |the |your )(?:[a-z-]+ )?team\b/g },
  // "lead your team's engineers", "lead a group of five engineers"
  { re: /\b(?:lead|leading)\s+(?:your team's|a group of|a pod of)\s+(?:[a-z0-9-]+\s+)?engineers\b/g, pre: OTHERS_BEFORE_RE },
];

function normalizeText(text) {
  return String(text ?? '')
    // A heading glued to the previous bullet by an HTML-to-text pass:
    // "mitigationsPreferred Qualifications".
    .replace(/([a-z0-9.)])(Preferred|Minimum|Basic|Required|Requirements|Qualifications|Responsibilities|Nice[- ]to[- ]have|Bonus|Benefits|About (?:us|the)|What (?:you|we))/g, '$1 $2')
    .replace(/\p{Pd}/gu, '-')
    .replace(/[\p{Pi}\p{Pf}]/gu, "'")
    .toLowerCase()
    // Entities an HTML-to-text pass left behind.
    .replace(/&(?:nbsp|#160|#xa0);/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&(?:#39|#x27|apos|rsquo|lsquo);/g, "'")
    .replace(/&(?:quot|ldquo|rdquo);/g, '"')
    // A heading glued to its first bullet: "Qualifications8+ years".
    .replace(/\b(qualifications|requirements|responsibilities|experience|skills|need|bring|have)(\d)/g, '$1 $2')
    // "a decade of experience" is a years figure.
    .replace(/\b(?:a|one|over a|more than a|at least a) (?:full |whole )?decade(\+?)/g, (m, plus) => `${m.replace(/(?:a|one) (?:full |whole )?decade\+?$/, '10')}${plus} years`)
    .replace(/\bdecade\+/g, '10+ years')
    .replace(/\btwo decades\b/g, '20 years')
    .replace(/\b(\w+)-plus years\b/g, '$1+ years')
    // Abbreviations whose periods would end a clause mid-requirement.
    .replace(/\bph\.\s?d\.?/g, 'phd')
    .replace(/\be\.g\./g, 'eg')
    .replace(/\bi\.e\./g, 'ie')
    .replace(/\bu\.s\.(?:a\.)?/g, 'us')
    .replace(/\b([bm])\.\s?([sa])\.(?:c\.)?/g, '$1$2')
    .replace(/\b(?:sr|min|approx)\./g, (m) => m.slice(0, -1))
    .replace(/\byrs?\./g, 'yrs')
    // Keep line breaks (headings live at line starts); collapse the rest.
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n[\n ]*/g, '\n');
}

// Sorted heading events: [{ at, end, kind }].
function headingEvents(text) {
  const events = [];
  for (const { kind, re } of HEADINGS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) events.push({ at: m.index, end: m.index + m[0].length, kind });
  }
  events.sort((a, b) => a.at - b.at || (a.kind === 'ignore' ? -1 : 1));
  // A count / softend word inside an ignore heading ("Preferred
  // Qualifications" contains "qualifications") is part of it, not a new section.
  return events.filter((e) => !((e.kind === 'count' || e.kind === 'softend')
    && events.some((o) => (o.kind === 'ignore' || o.kind === 'boiler') && o.at <= e.at && e.at < o.end)));
}

// Clause boundaries for local wording: sentence ends, line breaks, bullets
// (" - " / "•" in flattened text).
const CLAUSE_BREAK_RE = /[.;!?](?:\s|$)|\n|•| - /g;

function clauseBefore(text, at, n) {
  const s = text.slice(Math.max(0, at - n), at);
  let cut = -1;
  for (const m of s.matchAll(CLAUSE_BREAK_RE)) cut = m.index + m[0].length;
  return cut >= 0 ? s.slice(cut) : s;
}

function clauseAfter(text, at, n) {
  const s = text.slice(at, at + n);
  CLAUSE_BREAK_RE.lastIndex = 0;
  const m = CLAUSE_BREAK_RE.exec(s);
  return m ? s.slice(0, m.index) : s;
}

// Same-sentence window, ignoring bullets: for alternatives and substitutions
// that span a flattened line.
function sentenceBefore(text, at, n) {
  const s = text.slice(Math.max(0, at - n), at);
  const cut = Math.max(s.lastIndexOf('. '), s.lastIndexOf('\n'), s.lastIndexOf('! '), s.lastIndexOf('? '));
  return cut >= 0 ? s.slice(cut + 1) : s;
}

function quoteAround(text, start, end) {
  return `${clauseBefore(text, start, 110)}${text.slice(start, end)}${clauseAfter(text, end, 130)}`
    .replace(/\s+/g, ' ').trim();
}

function makeContext(description) {
  const text = normalizeText(description);
  const events = headingEvents(text);
  const sectionAt = (p) => {
    let kind = 'count';
    let boilerFrom = -1;
    for (const e of events) {
      if (e.at > p) break;
      if (e.end > p) continue;
      if (e.kind === 'softend') {
        if (kind === 'boiler') kind = 'count';
      } else {
        kind = e.kind;
        if (kind === 'boiler') boilerFrom = e.end;
      }
    }
    if (kind === 'boiler' && p - boilerFrom > BOILER_SPAN) kind = 'count';
    return kind;
  };
  const isPreference = (start, end) => {
    if (sectionAt(start) !== 'count') return true;
    const before = clauseBefore(text, start, 80);
    if (PREFERENCE_BEFORE_RE.test(before)) return true;
    const ownVerb = /\b(?:you(?:'ll| will)?\s+(?:bring|have|need)|you've|we need|requires?|must have|should have)\b|(?:^|[-*•]\s*)(?:have|bring|possess)\s+(?:at least\s+|over\s+)?$/.test(before);
    // A long parenthetical is its own clause: "(Kubernetes experience is a plus)".
    const after = text.slice(end, end + 240).replace(/\((?![^()]{0,12}\))[^()]*\)/g, ' ');
    return (ownVerb ? PREFERENCE_AFTER_STRICT_RE : PREFERENCE_AFTER_RE).test(after);
  };
  return { text, isPreference };
}

function toNumber(tok) {
  if (tok == null) return null;
  return /^\d+$/.test(tok) ? Number(tok) : WORD_NUMBERS[tok] ?? null;
}

// Every "N years" figure, with whether it measures experience.
function figuresIn(text) {
  const figures = [...text.matchAll(YEARS_RE)].map((m) => {
    const start = m.index;
    const end = start + m[0].length;
    const years = toNumber(m[1] ?? m[2]);
    const after = text.slice(end, end + 200);
    const before = text.slice(Math.max(0, start - 40), start);
    let experience = false;
    let strong = false;
    if (years != null && years >= 1 && years <= 40 && !TIME_WORD_BEFORE_RE.test(before)
        && !NOT_EXPERIENCE_BEFORE_RE.test(before) && !NOT_EXPERIENCE_AFTER_RE.test(after)) {
      strong = m[3] === 'yoe' || EXPERIENCE_NOUN_AFTER_RE.test(after) || EXPERIENCE_BEFORE_RE.test(before)
        || YOU_FOR_BEFORE_RE.test(clauseBefore(text, start, 120))
        // "Industry experience building EDR agents in C/C++ (8+ years)"
        || (/\(\s*$/.test(before) && /^\s*\)/.test(after) && /\bexperience\b/.test(clauseBefore(text, start, 200)));
      experience = strong || EXPERIENCE_VERB_AFTER_RE.test(after) || EXPERIENCE_PREP_AFTER_RE.test(after);
    }
    return { start, end, years, experience, strong };
  });
  for (const m of text.matchAll(LABEL_FIGURE_RE)) {
    const years = toNumber(m[1]);
    if (/\b(?:preferred|desired|ideal|desirable|bonus)\s*$/.test(text.slice(Math.max(0, m.index - 20), m.index))) continue;
    if (years != null && years >= 1 && years <= 40) {
      figures.push({ start: m.index, end: m.index + m[0].length, years, experience: true, strong: true });
    }
  }
  return figures.sort((a, b) => a.start - b.start);
}

/**
 * The experience requirement a JD sets, in years, and the text that sets it.
 * Degree / level alternatives count at their lowest figure; a degree offered in
 * place of the years waives it; preferred / nice-to-have figures never count.
 * @returns {{ years: number, quote: string } | null}
 */
export function findYearsRequirement(description) {
  const { text, isPreference } = makeContext(description);
  if (!text) return null;
  const figures = figuresIn(text);

  let best = null;
  for (let i = 0; i < figures.length; i++) {
    const f = figures[i];
    if (!f.experience) continue;
    const window = `${clauseBefore(text, f.start, 80)} ${clauseAfter(text, f.end, 80)}`;
    if (!f.strong && COMPANY_HISTORY_RE.test(window) && !YOU_RE.test(window)) continue;

    // Chain the alternatives that follow: ", or 13 years with an advanced degree".
    const group = [f];
    let last = f;
    for (let j = i + 1; j < figures.length; j++) {
      const g = figures[j];
      if (g.years == null || g.start - last.end > 450) break;
      const between = text.slice(last.end, g.start);
      if (/[.!?](?:\s|$)|\n\n/.test(between) || /,\s*and\s+(?:an?\s+)?$/.test(between)
          || !ALTERNATIVE_TAIL_RE.test(between)) break;
      group.push(g);
      last = g;
    }
    i += group.length - 1;
    if (isPreference(f.start, last.end)) continue;

    let years = Math.min(...group.map((g) => g.years));
    const tail = text.slice(last.end, last.end + 300);
    // Lowest degree-tagged alternative in the same clause: "…, 8+ with an MS, or 5+ with a PhD".
    const clauseTail = tail.slice(0, 160).split(/[.!?](?:\s|$)|\n/)[0];
    for (const d of clauseTail.matchAll(DEGREE_FIGURE_AFTER_RE)) years = Math.min(years, toNumber(d[1]) ?? years);
    const degreeTag = DEGREE_TAG_AFTER_RE.exec(tail);
    if (degreeTag) years = Math.min(years, toNumber(degreeTag[1]) ?? years);
    const substitution = SUBSTITUTION_AFTER_RE.exec(tail);
    if (substitution) {
      const n = toNumber(substitution[1]);
      years = n == null ? 0 : Math.max(0, years - n);
    }
    const sentBefore = sentenceBefore(text, f.start, 260);
    const orAfter = DEGREE_OR_AFTER_RE.exec(clauseAfter(text, f.end, 140));
    const degreeInsteadAfter = orAfter && !/\b(?:ms|master'?s?|bs|ba|bachelor'?s?|degree|with|ideally|preferably|including|in industry)\b/.test(orAfter[1]);
    if (PHD_ALONE_BEFORE_RE.test(sentBefore)
        || (group.length === 1
          && (DEGREE_OR_BEFORE_RE.test(sentBefore) || degreeInsteadAfter
            || DEGREE_OR_BULLET_AFTER_RE.test(text.slice(f.end, f.end + 260))))) {
      years = 0;
    }
    if (years <= 0) continue;
    if (!best || years > best.years) best = { years, quote: quoteAround(text, f.start, last.end) };
  }
  return best;
}

/**
 * Text that makes leading a team (the team's tech lead, or a people manager)
 * part of the job. Preferred / nice-to-have, negated and other-people mentions
 * never count, nor does anything in a JD that declares an IC seat.
 * @returns {{ quote: string, phrase: string } | null}
 */
export function findLeadDuty(description) {
  const { text, isPreference } = makeContext(description);
  if (!text) return null;
  // "This is an IC role" rules out people management, not being the team's
  // tech lead ("a senior IC … the senior technical leader for the team").
  const ic = IC_DECLARATION_RE.exec(text);
  const icSeat = Boolean(ic) && !/\b(?:not|isn't|is not|no longer)\s+(?:an?\s+)?$/.test(text.slice(Math.max(0, ic.index - 20), ic.index));
  let first = null;
  for (const { re, guard, pre, alternative, people } of LEAD_PATTERNS) {
    if (people && icSeat) continue;
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const start = m.index;
      const end = start + m[0].length;
      const before = clauseBefore(text, start, 60);
      if (guard && !guard(m[1] ?? '', m[2] ?? '', m[0], text.slice(end, end + 30))) continue;
      if (pre && pre.test(before)) continue;
      if (alternative && alternative.test(clauseAfter(text, end, 90))) continue;
      if (NEGATION_BEFORE_RE.test(before)) continue;
      if (people && FUTURE_BEFORE_RE.test(before)) continue;
      if (isPreference(start, end)) continue;
      if (!first || start < first.start) first = { start, end, phrase: m[0] };
      break;
    }
  }
  return first ? { phrase: first.phrase, quote: quoteAround(text, first.start, first.end) } : null;
}

function clip(s, n = 160) {
  const t = String(s).trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/**
 * @param {object|undefined} cfg - portals.yml `level_filter`
 * @param {{ fetchJd?: (url: string) => Promise<string|null> }} [deps]
 * @returns {null | {
 *   gated: (title: string) => boolean,
 *   assess: (title: string, description?: string) => LevelVerdict,
 *   check: (job: {title: string, url?: string, description?: string}) => Promise<LevelVerdict>,
 *   needsFetch: (job: {title: string, url?: string, description?: string}) => boolean,
 *   minYears: number,
 * }} null when disabled.
 *
 * LevelVerdict = { drop, gated, reason, note, fetched }
 *   gated   — the title carries a block word (after exemptions)
 *   drop    — gated AND the JD shows min_years+ or a team-lead duty
 *   reason  — for a drop: the evidence, quoted
 *   note    — for a gated posting that is kept: what stage 2 should check
 *   fetched — check() fetched the JD because the listing had none
 */
export function buildLevelFilter(cfg, deps = {}) {
  if (!cfg || typeof cfg !== 'object' || cfg.enabled !== true) return null;
  const block = normalizeList(cfg.block).map((w) => compileKeyword(`word:${w.replace(/^word:/, '')}`));
  if (block.length === 0) return null;
  // Longest first, so "member of technical staff" is blanked before "technical staff".
  const exempt = normalizeList(cfg.exempt).sort((a, b) => b.length - a.length);
  const minYears = Number.isFinite(cfg.min_years) && cfg.min_years > 0 ? cfg.min_years : DEFAULT_MIN_YEARS;
  const fetchJd = cfg.fetch_jd === false ? null : deps.fetchJd ?? null;

  const gated = (title) => {
    let lower = String(title ?? '').toLowerCase();
    if (MULTI_LEVEL_WITH_SENIOR_RE.test(lower)) return false;
    for (const phrase of exempt) lower = lower.split(phrase).join(' ');
    return block.some((matches) => matches(lower));
  };

  const assess = (title, description) => {
    if (!gated(title)) return { drop: false, gated: false, reason: null, note: null };
    const text = typeof description === 'string' ? description : '';
    if (text.trim().length < MIN_JD_CHARS) {
      return {
        drop: false, gated: true, reason: null,
        note: `level-check: Staff+ title, no JD text to read — drop in stage 2 if it requires ${minYears}+ yrs or team lead`,
      };
    }
    const years = findYearsRequirement(text);
    if (years && years.years >= minYears) {
      return { drop: true, gated: true, reason: `requires ${years.years}+ yrs: "${clip(years.quote)}"`, note: null };
    }
    const lead = findLeadDuty(text);
    if (lead) {
      return { drop: true, gated: true, reason: `team lead: "${clip(lead.quote)}"`, note: null };
    }
    const asks = years ? `requires ${years.years} yrs` : 'states no required years';
    return {
      drop: false, gated: true, reason: null,
      note: `level-check: Staff+ title, JD ${asks}, no team-lead duty found`,
    };
  };

  // True when check() would go to the network. Callers that dedup across
  // concurrent tasks use it to stay synchronous (assess) in the common case.
  const needsFetch = (job) => Boolean(fetchJd && job?.url && gated(job?.title)
    && (typeof job?.description === 'string' ? job.description : '').trim().length < MIN_JD_CHARS);

  const check = async (job) => {
    const own = typeof job?.description === 'string' ? job.description : '';
    if (!needsFetch(job)) return { ...assess(job?.title, own), fetched: false };
    let fetched = null;
    try { fetched = await fetchJd(job.url); } catch { /* keep: stage 2 reads it */ }
    const got = typeof fetched === 'string' && fetched.trim().length > own.trim().length;
    return { ...assess(job.title, got ? fetched : own), fetched: got };
  };

  return { gated, assess, check, needsFetch, minYears };
}
