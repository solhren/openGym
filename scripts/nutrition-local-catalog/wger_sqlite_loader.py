"""Importable literal tokenizer shared by the full reader (no fuzzy fallback)."""
from catalog import search_text,require

def literal_matches(query):
    require(type(query) is str and 2<=len(query)<=120,'invalid-query')
    tokens=search_text(query).split()
    require(1<=len(tokens)<=8 and all(1<=len(v)<=40 for v in tokens),'invalid-query')
    return ' AND '.join('"'+v+'"'+('*' if i==len(tokens)-1 and len(v)>=3 else '') for i,v in enumerate(tokens))
