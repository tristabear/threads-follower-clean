// Word lists used by the "animal name + number" heuristic (rule a).
// These are starter lists, not exhaustive. If you notice a bot pattern using
// a word that isn't here, add it — the file is plain JS arrays, no build step.

const ENGLISH_ANIMALS = [
  'tiger', 'lion', 'wolf', 'fox', 'bear', 'panda', 'rabbit', 'bunny', 'eagle',
  'shark', 'dragon', 'phoenix', 'hawk', 'falcon', 'owl', 'raven', 'crow',
  'deer', 'elk', 'moose', 'bison', 'buffalo', 'horse', 'pony', 'zebra',
  'giraffe', 'elephant', 'rhino', 'hippo', 'monkey', 'gorilla', 'chimp',
  'koala', 'kangaroo', 'sloth', 'otter', 'beaver', 'squirrel', 'chipmunk',
  'hedgehog', 'raccoon', 'skunk', 'badger', 'weasel', 'ferret', 'mink',
  'cat', 'kitten', 'kitty', 'dog', 'puppy', 'pup', 'wolfpup',
  'duck', 'goose', 'swan', 'penguin', 'flamingo', 'peacock', 'parrot',
  'sparrow', 'robin', 'finch', 'dove', 'pigeon', 'stork', 'heron', 'crane',
  'snake', 'cobra', 'viper', 'python', 'lizard', 'gecko', 'iguana',
  'turtle', 'tortoise', 'crocodile', 'alligator', 'gator',
  'frog', 'toad', 'newt', 'salamander',
  'fish', 'goldfish', 'salmon', 'trout', 'bass', 'catfish', 'eel',
  'whale', 'dolphin', 'orca', 'seal', 'walrus', 'octopus', 'squid', 'jellyfish',
  'crab', 'lobster', 'shrimp', 'starfish',
  'bee', 'wasp', 'ant', 'spider', 'scorpion', 'butterfly', 'moth', 'dragonfly',
  'beetle', 'ladybug', 'cricket', 'grasshopper', 'mantis',
  'mouse', 'rat', 'hamster', 'gerbil', 'chinchilla', 'guineapig',
  'pig', 'boar', 'hog', 'sheep', 'lamb', 'goat', 'cow', 'bull', 'ox', 'calf',
  'llama', 'alpaca', 'camel', 'donkey', 'mule',
  'cheetah', 'leopard', 'panther', 'jaguar', 'lynx', 'puma', 'cougar', 'bobcat',
  'hyena', 'jackal', 'meerkat', 'mongoose', 'armadillo', 'anteater', 'platypus',
  'bat', 'possum', 'opossum', 'wombat', 'lemur', 'baboon', 'orangutan',
  'stallion', 'mustang', 'unicorn', 'griffin', 'pegasus',
];

// Small starter set of common Chinese animal characters/words. Threads has a
// large Taiwan-based bot problem (see rule b), so bot usernames sometimes use
// Chinese animal words instead of English ones. Extend this freely.
const CHINESE_ANIMALS = [
  '貓', '貓咪', '狗', '狗狗', '虎', '老虎', '兔', '兔子', '熊', '熊貓',
  '鳥', '魚', '龍', '鷹', '狼', '獅', '獅子', '象', '猴', '猴子',
  '豬', '羊', '牛', '馬', '蛇', '鼠', '老鼠', '鹿', '狐狸', '烏龜',
];

const ALL_ANIMAL_WORDS = [...ENGLISH_ANIMALS, ...CHINESE_ANIMALS];

module.exports = { ENGLISH_ANIMALS, CHINESE_ANIMALS, ALL_ANIMAL_WORDS };
