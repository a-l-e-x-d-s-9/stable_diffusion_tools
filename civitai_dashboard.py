import sqlite3
import datetime
import pandas as pd
import plotly.express as px
import requests
import dash
from dash import dcc
from dash import html
from dash.dependencies import Input, Output
import argparse

DB_NAME = "downloads.db"

# Initialize the database
def init_db():
    conn = sqlite3.connect(DB_NAME)
    cur = conn.cursor()
    cur.execute("""
    CREATE TABLE IF NOT EXISTS downloads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        model_id INTEGER NOT NULL,
        model_name TEXT NOT NULL,
        download_count INTEGER NOT NULL,
        timestamp DATETIME NOT NULL
    );
    """)
    conn.commit()
    conn.close()

# Store data in the database
def store_data_in_db(download_data):
    conn = sqlite3.connect(DB_NAME)
    cur = conn.cursor()
    for item in download_data:
        cur.execute("""
        INSERT INTO downloads (model_id, model_name, download_count, timestamp)
        VALUES (?, ?, ?, ?)
        """, (item['id'], item['name'], item['download_count'], datetime.datetime.now()))
    conn.commit()
    conn.close()

# Fetch models for a user
def get_models_for_user(username, page=1, limit=100):
    base_url = 'https://civitai.com/api/v1/models'
    response = requests.get(f'{base_url}?username={username}&page={page}&limit={limit}')
    return response.json()

# Extract download data for models
def extract_download_data(data):
    download_data = []
    for model in data['items']:
        if 'id' not in model or 'name' not in model or 'stats' not in model or 'downloadCount' not in model['stats']:
            continue  # Skip this model if the required data is missing
        model_id = model['id']
        model_name = model['name']
        download_count = model['stats']['downloadCount']
        download_data.append({'id': model_id, 'name': model_name, 'download_count': download_count})
    return download_data


page = 1
limit = 10
download_data = []


# Fetch data from the database for a specific time frame
def get_downloads_for_timeframe(timeframe_minutes):
    conn = sqlite3.connect(DB_NAME)
    cur = conn.cursor()
    time_threshold = datetime.datetime.now() - datetime.timedelta(minutes=timeframe_minutes)
    cur.execute("""
    SELECT model_name, MAX(download_count) - MIN(download_count) as downloads
    FROM downloads
    WHERE timestamp >= ?
    GROUP BY model_id, model_name
    """, (time_threshold,))
    data = cur.fetchall()
    conn.close()
    return data




# Pull and store data every minute
def pull_and_store_data(username):
    page = 1
    limit = 100

    while True:
        data = get_models_for_user(username, page, limit)
        download_data = extract_download_data(data)
        store_data_in_db(download_data)

        if 'nextPage' in data['metadata']:
            page += 1
        else:
            break


conn = init_db()


# Set up the Dash app
app = dash.Dash(__name__)

app.layout = html.Div([
    html.Label('Timeframe:'),
    dcc.Dropdown(
        id='timeframe-dropdown',
        options=[
            {'label': '1 min', 'value': 1},
            {'label': '5 min', 'value': 5},
            {'label': '15 min', 'value': 15},
            {'label': '30 min', 'value': 30},
            {'label': '1h', 'value': 60},
            {'label': '2h', 'value': 120},
            {'label': '5h', 'value': 300},
            {'label': '10h', 'value': 600},
            {'label': '12h', 'value': 720},
            {'label': '24h', 'value': 1440}
        ],
        value=60
    ),
    html.Label('Pull from server every:'),
    dcc.Dropdown(
        id='pull-interval-dropdown',
        options=[
            {'label': '10 sec', 'value': 10},
            {'label': '30 sec', 'value': 30},
            {'label': '1 min', 'value': 60},
            {'label': '5 min', 'value': 300},
            {'label': '30 min', 'value': 1800},
        ],
        value=60
    ),
    dcc.Graph(id='downloads-graph'),
    dcc.Interval(
        id='interval-component',
        interval=60*1000,  # Update every minute
        n_intervals=0
    )
])



@app.callback(Output('downloads-graph', 'figure'), [Input('interval-component', 'n_intervals'), Input('timeframe-dropdown', 'value')])
def update_graph(n, timeframe):
    pull_and_store_data(username)
    data = get_downloads_for_timeframe(timeframe)
    df = pd.DataFrame(data, columns=['model_name', 'downloads'])

    fig = px.bar(df, x='model_name', y='downloads', title=f'Download Count per Model for Last {timeframe} Minutes')
    fig.update_layout(xaxis_tickangle=-45)
    return fig

@app.callback(Output('interval-component', 'interval'), [Input('pull-interval-dropdown', 'value')])
def update_pull_interval(pull_interval):
    return pull_interval * 1000  # Convert to milliseconds

# Parse the command-line arguments
parser = argparse.ArgumentParser(description='CivitAI Dashboard')
parser.add_argument('--username', type=str, required=True, help='The username to fetch data for')
args = parser.parse_args()
username = args.username

if __name__ == '__main__':
    app.run_server(debug=True)
