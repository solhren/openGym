"""Bounded spelling fallback for immutable FTS5 catalogues.

Trigrams retrieve vocabulary candidates, never product rows to compare in Python.
Only a zero-result literal search uses edit distance. These limits trade recall
for predictable work; they are not a claim that every typo can be corrected.
"""
import itertools

MAX_POSTINGS = 256
MAX_CANDIDATES = 128
MAX_ALTERNATIVES = 3
MAX_PHRASES = 16


def grams(term):
    return sorted({term[i:i + 3] for i in range(len(term) - 2)})


def distance(left, right, maximum):
    """Optimal-string-alignment Damerau distance, bounded to short vocabulary terms.
    Adjacent transpositions count once. This is OSA, not unrestricted Damerau.
    """
    if abs(len(left) - len(right)) > maximum:
        return maximum + 1
    older = None
    previous = list(range(len(right) + 1))
    for i, a in enumerate(left, 1):
        row = [i]
        for j, b in enumerate(right, 1):
            value = min(row[j - 1] + 1, previous[j] + 1, previous[j - 1] + (a != b))
            if older is not None and i > 1 and j > 1 and a == right[j - 2] and left[i - 2] == b:
                value = min(value, older[j - 2] + 1)
            row.append(value)
        older, previous = previous, row
    return previous[-1]


def create_index(connection, fold, check_resources=lambda: None):
    connection.executescript('''
        CREATE TABLE search_terms(term TEXT NOT NULL, expansion TEXT NOT NULL,
            PRIMARY KEY(term,expansion)) WITHOUT ROWID;
        CREATE TABLE search_grams(gram TEXT NOT NULL, length INTEGER NOT NULL, term TEXT NOT NULL,
            PRIMARY KEY(gram,length,term)) WITHOUT ROWID;
        CREATE VIRTUAL TABLE vocabulary USING fts5vocab(products_fts,'row');
    ''')
    def insert(term, expansion):
        if not 2 <= len(term) <= 40:
            return
        connection.execute('INSERT OR IGNORE INTO search_terms VALUES (?,?)', (term, expansion))
        connection.executemany('INSERT OR IGNORE INTO search_grams VALUES (?,?,?)', ((g, len(term), term) for g in grams(term)))
    for index, (term,) in enumerate(connection.execute('SELECT term FROM vocabulary')):
        if index % 500 == 0: check_resources()
        insert(fold(term), fold(term))
    # Standard separator normalization: retain an expansion into real FTS tokens.
    # Adjacent pairs let "cocacola" match "Coca-Cola" without a full-row distance.
    for index, row in enumerate(connection.execute('SELECT name,name_fr,brand FROM products')):
        if index % 500 == 0: check_resources()
        for field in row:
            words = fold(field).split()
            for a, b in zip(words, words[1:]):
                insert(a + b, a + ' ' + b)
    connection.execute('DROP TABLE vocabulary')


def alternatives(connection, token, deadline_check):
    exact = connection.execute('SELECT expansion FROM search_terms WHERE term=? ORDER BY expansion LIMIT ?', (token, MAX_ALTERNATIVES)).fetchall()
    if exact:
        return [(0, value[0]) for value in exact]
    maximum = 0 if len(token) < 4 else 1 if len(token) < 7 else 2
    if maximum == 0:
        return []
    overlap = {}
    for gram in grams(token):
        deadline_check()
        # A fixed posting cap per indexed gram is a deliberate recall limit.
        for (term,) in connection.execute('SELECT term FROM search_grams WHERE gram=? AND length BETWEEN ? AND ? ORDER BY length,term LIMIT ?', (gram, len(token) - maximum, len(token) + maximum, MAX_POSTINGS)):
            overlap[term] = overlap.get(term, 0) + 1
    candidates = sorted(overlap, key=lambda term: (-overlap[term], abs(len(term) - len(token)), term))[:MAX_CANDIDATES]
    ranked = []
    for term in candidates:
        deadline_check()
        cost = distance(token, term, maximum)
        if cost <= maximum:
            for (expansion,) in connection.execute('SELECT expansion FROM search_terms WHERE term=? ORDER BY expansion LIMIT ?', (term, MAX_ALTERNATIVES)):
                ranked.append((cost, -overlap[term], expansion))
    return [(cost, expansion) for cost, _, expansion in sorted(set(ranked))[:MAX_ALTERNATIVES]]


def fallback_match(connection, tokens, deadline_check):
    choices = [alternatives(connection, token, deadline_check) for token in tokens]
    if any(not values for values in choices):
        return None
    phrases = sorted(itertools.product(*choices), key=lambda items: (sum(item[0] for item in items), items))[:MAX_PHRASES]
    # All expansions come from normalized corpus vocabulary, still quote tokens.
    expression = ' OR '.join('(' + ' AND '.join('"' + part + '"' for _, expansion in phrase for part in expansion.split()) + ')' for phrase in phrases)
    scores = [(sum(cost for cost, _ in phrase), {word for _, expansion in phrase for word in expansion.split()}) for phrase in phrases]
    return expression, scores
