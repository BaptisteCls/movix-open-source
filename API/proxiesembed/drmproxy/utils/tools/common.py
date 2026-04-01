import json
import os
import random
import re
import string
from math import ceil
from urllib.parse import urlparse, parse_qs, urlencode, urlunparse

import numpy as np
import requests
import unicodedata
from unidecode import unidecode

from utils.constants.macros import TMP_RAND_LEN, CONFIG_FILE
from utils.constants.portable import CMD_ADJUST


def split_list_chunks(lst, chunks):
    chunks = [list(c) for c in np.array_split(lst, chunks)]
    return [c for c in chunks if len(c) > 0]


def flatten_list(lst):
    if len(lst) > 0 and type(lst[0]) is list:
        lst = [_ for r in lst for _ in r]
    return lst


def get_base_url(url):
    parsed_url = urlparse(url)
    domain_parts = parsed_url.netloc.split('.')
    if 'www' in domain_parts[0]:
        return '.'.join(domain_parts[1:])
    return parsed_url.netloc


def file_to_list(file_path):
    with open(file_path, 'r') as file:
        lines = file.readlines()
    lines = [line.strip() for line in lines]
    lines = [line for line in lines if len(line) > 0]
    return list(dict.fromkeys(lines))


def list_to_file(file_path, l):
    with open(file_path, 'w') as file:
        for e in l:
            file.write(e + '\n')


def rand_str(rand_len=TMP_RAND_LEN):
    return ''.join(random.choice(string.ascii_letters + string.digits) for _ in range(rand_len))


def get_width_res_from_height(height):
    width = (height * 16) / 9
    return int(ceil(width))


LATIN_LETTERS = {}


def is_latin_char(character):
    try:
        return LATIN_LETTERS[character]
    except KeyError:
        return LATIN_LETTERS.setdefault(character, 'LATIN' in unicodedata.name(character))


def has_only_roman_chars(input_string):
    if input_string is None or type(input_string) is not str:
        return False
    return all(
        is_latin_char(character)
        for character in input_string
        if character.isalpha()
    )


def get_valid_filename(name):
    if name is None or len(name) == 0:
        return None
    try:
        temp_name = unidecode(name)
        if temp_name is not None and len(temp_name) > 0:
            name = temp_name
    except:
        pass

    s = str(name).strip()
    s = re.sub(r'\s+', ' ', s)
    s = s.replace(" ", "_")
    s = re.sub(r"(?u)[^-\w.]", "", s)
    s = re.sub(r'_+', '_', s)
    s = re.sub(r'\.+', '', s)

    if s in {"", ".", ".."}:
        return None
    return s


def get_ext_from_url(url):
    try:
        _, url_ext = os.path.splitext(os.path.basename(urlparse(url).path))
        return url_ext
    except:
        return ""


def get_last_path(url):
    if url is None or len(url) == 0:
        return None

    for p in reversed(url.split("/")):
        if len(p) == 0:
            continue
        return p
    return None


def remove_last_path_segment(url):
    url = url.rstrip("/")
    parsed_url = urlparse(url)

    path_segments = parsed_url.path.rstrip('/').split('/')
    if len(path_segments) > 1:
        new_path = '/'.join(path_segments[:-1])
    else:
        new_path = ''

    new_url = urlunparse(parsed_url._replace(path=new_path))
    return new_url


def get_nr_paths(url):
    if url is None or len(url) == 0:
        return 0

    count = 0
    for p in url.split("/"):
        if len(p) == 0:
            continue
        count += 1
    return count


def dict_to_file(file, d):
    if file != CONFIG_FILE:
        with open(file, 'w') as f:
            f.write(json.dumps(d))
    else:
        with open(file, 'w') as json_file:
            json.dump(d, json_file, indent=4)


def file_to_dict(file):
    try:
        with open(file, 'r') as f:
            return json.loads(f.read())
    except:
        return {}


def update_url_params(url, new_params):
    parsed_url = urlparse(url)
    query_params = parse_qs(parsed_url.query)

    for key, value in new_params.items():
        query_params[key] = [str(value)]

    updated_query = urlencode(query_params, doseq=True)
    updated_url = urlunparse((
        parsed_url.scheme, parsed_url.netloc, parsed_url.path,
        parsed_url.params, updated_query, parsed_url.fragment
    ))
    return updated_url


def get_public_ip():
    try:
        return requests.get('https://checkip.amazonaws.com').text.strip().split(",")[-1]
    except:
        return None


def get_country_code():
    try:
        response = requests.get(f"https://ip2c.org/{get_public_ip()}")
        return response.text.split(";")[1]
    except:
        return None


def is_http_url(u):
    return (
            u is not None and len(u) > 0 and
            (u.startswith("https://") or u.startswith("http://"))
    )


def clean_url(url):
    return url.split("?")[0].split("#")[0].rstrip("/")


def adjust_parameters(use_adjust, params):
    if not use_adjust:
        return params
    return params.replace("|", f'{CMD_ADJUST}|')
