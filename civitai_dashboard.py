import sqlite3
import datetime
import pandas as pd
import requests
import dash
from dash import dcc
from dash import html
from dash.dependencies import Input, Output
import plotly.express as px

# Fetch models for a user
def get_models_for_user(username, page=1, limit=100):
    base_url = 'https://civitai.com/api/v1/models'
    response = requests.get(f'{base_url}?username={username}&page={page}&limit={limit}')
    return response.json()

# Extract download data for models
def extract_download_data(data):
    download_data = []
    for model in data['items']:
        model_id = model['id']
        model_name = model['name']
        download_count = model['stats']['downloadCount']
        download_data.append({'id': model_id, 'name': model_name, 'download_count': download_count})
    return download_data

username = 'alexds9'
page = 1
limit = 10
download_data = []

while True:
    data = get_models_for_user(username, page, limit)
    download_data.extend(extract_download_data(data))

    if 'nextPage' in data['metadata']:
        page += 1
    else:
        break

df = pd.DataFrame(download_data)

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

@app.callback(Output('downloads-graph', 'figure'), Input('interval-component', 'n_intervals'))
def update_graph(n):
    fig = px.bar(df, x='name', y='download_count', title='Download Count per Model')
    fig.update_xaxes(tickangle=45)
    return fig

if __name__ == '__main__':
    app.run_server(debug=True)
