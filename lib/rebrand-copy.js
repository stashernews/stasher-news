// Flag-aware copy map for the visual-identity rebrand. Legacy (cowboy)
// strings stay verbatim for flag-off rollback. The stealth voice speaks in
// the persona of a very particular ghost: unhinged, bombastic, dark-humored.
// Project rule: no emdashes anywhere in the stealth copy.
const LEGACY = {
  logoutConfirm: 'I reckon you want to logout?',
  signupTagline: 'We saved you a seat, pardner.',
  newsletterGreeting: 'Yeehaw,',
  mutesHeader: 'Well now, reckon these here are the folks you\'ve gone and silenced.',
  welcomeEmailGreeting: 'Yeehaw,',
  welcomeEmailPs: 'P.S. We\'re thrilled you\'re joinin\' the posse!',
  liveStreamLine: 'Stasher News Live is streaming this week\'s top stories',
  loginResumeLine: 'Nothing wrestles up a smile like a familiar face.',
  loginPrompt: 'New to town?'
}

const STEALTH = {
  logoutConfirm: 'Leaving? Run, then. I\'ll be here, cackling at the void.',
  signupTagline: 'You found the back door. Welcome. The ghosts are friendly.',
  newsletterGreeting: 'Fellow fugitives,',
  mutesHeader: 'These souls crossed you. Now they can\'t even see you. Beautiful.',
  welcomeEmailGreeting: 'So you made it. Impressive. Few do.',
  welcomeEmailPs: 'P.S. They know you\'re here. Don\'t worry. We\'ve been watching them longer.',
  liveStreamLine: 'Stasher News Live. The truth, streamed while it\'s still hot.',
  loginResumeLine: 'Look who crawled back from the shadows. Welcome.',
  loginPrompt: 'Fresh face. Unproven. Welcome anyway.'
}

export function rebrandCopy (rebrand) {
  return rebrand ? STEALTH : LEGACY
}
