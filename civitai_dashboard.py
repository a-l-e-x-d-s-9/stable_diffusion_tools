import sqlite3
import datetime
import plotly.express as px
import dash
from dash import dcc
from dash import html
from dash.dependencies import Input, Output
import requests
import matplotlib.pyplot as plt

# Set up the SQLite database
def init_db():
    conn = sqlite3.connect("downloads.db")
    cur = conn.cursor()

    cur.execute("""
    CREATE TABLE IF NOT EXISTS downloads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        count INTEGER NOT NULL
    );
    """)
    conn.commit()

    return conn

def add_dummy_data(conn):
    cur = conn.cursor()

    # Add dummy data for the last 7 days
    for i in range(7):
        date = (datetime.datetime.now() - datetime.timedelta(days=i)).strftime("%Y-%m-%d")
        count = i * 100

        cur.execute("INSERT OR IGNORE INTO downloads (date, count) VALUES (?, ?)", (date, count))

    conn.commit()

def get_data(conn):
    cur = conn.cursor()

    cur.execute("SELECT date, count FROM downloads ORDER BY date")
    data = cur.fetchall()

    return data

conn = init_db()
add_dummy_data(conn)

# Set up the Dash app
app = dash.Dash(__name__)

app.layout = html.Div([
    dcc.Graph(id='downloads-graph'),
    dcc.Interval(
        id='interval-component',
        interval=24*60*60*1000,  # Update the graph every 24 hours
        n_intervals=0
    )
])


def get_models_for_user(username, page=1, limit=100):
    base_url = 'https://civitai.com/api/v1/models'
    response = requests.get(f'{base_url}?username={username}&page={page}&limit={limit}')
    return response.json()


def extract_download_data(data):
    download_data = []
    for model in data['items']:
        model_id = model['id']
        model_name = model['name']
        download_count = model['stats']['downloadCount']
        download_data.append({'id': model_id, 'name': model_name, 'download_count': download_count})
    return download_data


def plot_download_data(download_data):
    model_names = [model['name'] for model in download_data]
    download_counts = [model['download_count'] for model in download_data]

    plt.bar(model_names, download_counts)
    plt.xlabel('Model Name')
    plt.ylabel('Download Count')
    plt.title('Download Count per Model')
    plt.xticks(rotation=90)
    plt.show()

@app.callback(Output('downloads-graph', 'figure'), Input('interval-component', 'n_intervals'))
def update_graph(n):
    data = get_data(conn)
    df = pd.DataFrame(data, columns=['date', 'count'])

    fig = px.line(df, x='date', y='count', title='Daily Downloads')
    return fig

if __name__ == '__main__':
    app.run_server(debug=True)
