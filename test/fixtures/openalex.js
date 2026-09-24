// OpenAlex-shaped records for tests and for running the page without network.
// Real field names and structure; invented papers.

const inverted = (text) => {
  const index = {};
  text.split(' ').forEach((word, i) => { (index[word] ||= []).push(i); });
  return index;
};

const author = (name, id) => ({ author: { id: `https://openalex.org/A${id}`, display_name: name } });

export const WORKS = [
  {
    id: 'https://openalex.org/W1001',
    doi: 'https://doi.org/10.1016/j.sleep.2019.04.012',
    display_name: 'Sleep deprivation and working memory in adolescents: a randomized crossover trial',
    publication_year: 2019,
    publication_date: '2019-06-01',
    type: 'article',
    authorships: [author('Hannah R. Okafor', 1), author('Tomás de la Cruz', 2), author('Mei Lin', 3)],
    primary_location: {
      landing_page_url: 'https://doi.org/10.1016/j.sleep.2019.04.012',
      source: { display_name: 'Sleep Medicine', type: 'journal', host_organization_name: 'Elsevier BV' },
    },
    best_oa_location: { pdf_url: 'https://example.org/okafor2019.pdf', landing_page_url: null },
    open_access: { is_oa: true, oa_url: 'https://example.org/okafor2019.pdf' },
    biblio: { volume: '58', issue: '3', first_page: '112', last_page: '120' },
    cited_by_count: 214,
    referenced_works_count: 48,
    is_retracted: false,
    abstract_inverted_index: inverted('We examined whether one night of restricted sleep affects working memory in adolescents. In a randomized crossover design, 84 students aged 14 to 17 completed an n-back task after a normal night and after five hours of sleep. We found that sleep restriction significantly reduced accuracy on the 2-back task compared to the rested condition (d = 0.62). These results suggest that even a single short night impairs working memory in this age group, e.g. during examination periods.'),
    related_works: ['https://openalex.org/W1002', 'https://openalex.org/W1003'],
    keywords: [{ display_name: 'Working memory' }, { display_name: 'Sleep restriction' }],
    primary_topic: { display_name: 'Sleep and Cognition', field: { display_name: 'Neuroscience' } },
  },
  {
    id: 'https://openalex.org/W1002',
    doi: 'https://doi.org/10.1037/dev0000987',
    display_name: 'Chronic short sleep and executive function across adolescence: a longitudinal cohort study',
    publication_year: 2021,
    publication_date: '2021-02-11',
    type: 'article',
    authorships: [author('Priya Natarajan', 4), author('James O. Whitfield', 5)],
    primary_location: {
      landing_page_url: 'https://doi.org/10.1037/dev0000987',
      source: { display_name: 'Developmental Psychology', type: 'journal', host_organization_name: 'American Psychological Association' },
    },
    best_oa_location: null,
    open_access: { is_oa: false },
    biblio: { volume: '57', issue: '2', first_page: '301', last_page: '315' },
    cited_by_count: 97,
    referenced_works_count: 71,
    is_retracted: false,
    abstract_inverted_index: inverted('Short sleep is common among adolescents but its long-term cognitive consequences remain unclear. Using four annual waves from 2,310 participants, we tested whether habitual sleep duration predicted change in executive function. Shorter sleep was associated with slower gains in working memory and inhibitory control, although the effects were small.'),
    related_works: ['https://openalex.org/W1001'],
    keywords: [{ display_name: 'Executive function' }],
    primary_topic: { display_name: 'Sleep and Cognition', field: { display_name: 'Psychology' } },
  },
  {
    id: 'https://openalex.org/W1003',
    doi: 'https://doi.org/10.1093/sleep/zsaa101',
    display_name: 'Slow-wave sleep and memory consolidation: a meta-analysis',
    publication_year: 2020,
    publication_date: '2020-09-30',
    type: 'review',
    authorships: [author('Lars van den Berg', 6)],
    primary_location: {
      landing_page_url: 'https://doi.org/10.1093/sleep/zsaa101',
      source: { display_name: 'SLEEP', type: 'journal', host_organization_name: 'Oxford University Press' },
    },
    best_oa_location: { pdf_url: null, landing_page_url: 'https://example.org/vandenberg2020' },
    open_access: { is_oa: true },
    biblio: { volume: '43', issue: '9', first_page: 'zsaa101', last_page: null },
    cited_by_count: 388,
    referenced_works_count: 156,
    is_retracted: false,
    abstract_inverted_index: inverted('Memory consolidation is thought to be enhanced during slow-wave sleep because hippocampal replay is increased. Across 61 studies, slow-wave sleep duration was positively associated with overnight retention of declarative memories. However, little is known about its role in older adults.'),
    related_works: [],
    keywords: [],
    primary_topic: { display_name: 'Sleep and Memory', field: { display_name: 'Neuroscience' } },
  },
];

export const byId = (id) => WORKS.find((w) => w.id.endsWith(`/${id}`));
